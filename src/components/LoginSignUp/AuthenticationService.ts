import type { QueryClient } from "@tanstack/query-core";
import type { ApiUser } from "api/types";
import { getUserAgent } from "api/userAgent";
import { fetchUserEmailAvailable, fetchUserMe } from "api/users";
import type { ApiResponse, ApisauceInstance } from "apisauce";
import { create } from "apisauce";
import {
  computerVisionPath,
  photoLibraryPhotosPath,
  photoUploadPath,
  rotatedOriginalPhotosPath,
  soundUploadPath,
} from "appConstants/paths";
import { getInatLocaleFromSystemLocale } from "i18n/initI18next";
import i18next from "i18next";
import rs from "jsrsasign";
import { navigationRef } from "navigation/navigationUtils";
import { Alert, AppState, Platform } from "react-native";
import Config from "react-native-config";
import * as RNLocalize from "react-native-localize";
import RNRestart from "react-native-restart";
import {
  deleteItem,
  ErrorCode,
  getItem,
  hasItem,
  SensitiveInfoError,
  setItem,
} from "react-native-sensitive-info";
import Realm, { UpdateMode } from "realm";
import realmConfig from "realmModels/index";
import changeLanguage from "sharedHelpers/changeLanguage";
import { getInstallID } from "sharedHelpers/installData";
import { log, logFileDirectory } from "sharedHelpers/logger";
import removeAllFilesFromDirectory from "sharedHelpers/removeAllFilesFromDirectory";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { setFirebaseDataCollectionEnabled } from "sharedHelpers/tracking";
import useStore from "stores/useStore";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

function isDebugModeSync( ): boolean {
  return useStore.getState().layout.debugModeEnabled === true;
}

const logger = log.extend( "AuthenticationService" );

// Base API domain can be overridden (in case we want to use staging URL) -
// either by placing it in .env file, or in an environment variable.
const API_HOST: string = Config.OAUTH_API_URL || process.env.OAUTH_API_URL || "https://www.inaturalist.org";

// JWT Tokens expire after 30 mins - consider 25 mins as the max time
// (safe margin). Actually they expire in 24 hours, but ideally they would
// expire every 30 mins, so might as well be futureproof.
const JWT_EXPIRATION_MINS = 25;

// How long past that we'll keep using a token the API wouldn't let us refresh,
// when the refresh failed because we couldn't reach the API rather than because
// it rejected us (see getJWT). Comfortably inside the 24 hours these tokens
// really last, so the fallback covers an ordinary network outage; past it, a
// refresh has been failing long enough that a null token is the honest answer.
const JWT_ACTUAL_EXPIRATION_MINS = 60;

interface AuthCache {
  isLoggedIn: boolean | null;
  lastChecked: number | null;
  cacheTimeout: number;
}

/**
 * Cache for isLoggedIn, to avoid making too many calls to getItem
 */
const authCache: AuthCache = {
  isLoggedIn: null,
  lastChecked: null,
  cacheTimeout: 5000,
};

// module-level tracking of jwt failures. This works around a
// fault where different parties were competing for retries
// during downtime or cascading auth failure, sometimes requring
// user-initiated app restart to heal.
let jwtRefreshFailureCount = 0;
let jwtRefreshFailedAt: number | null = null;
const JWT_REFRESH_BACKOFF_BASE_MS = 5_000;
const JWT_REFRESH_BACKOFF_MAX_MS = 60_000;

// A backgrounded upload run asks isLoggedIn once per observation, so the
// unreadable-keychain warning below is paced rather than emitted per call.
const KEYCHAIN_UNREADABLE_LOG_INTERVAL_MS = 60_000;
let lastKeychainUnreadableLoggedAt = 0;

/**
 * Clear cache for isLoggedIn, and any JWT refresh failure backoff.
 */
const clearAuthCache = ( ): void => {
  authCache.isLoggedIn = null;
  authCache.lastChecked = null;
  jwtRefreshFailureCount = 0;
  jwtRefreshFailedAt = null;
};

async function getSensitiveItem(
  key: string,
  options = {
    service: "app" as const,
  },
) {
  let exists;
  try {
    exists = await hasItem( key, options );
  } catch ( e ) {
    if ( e instanceof SensitiveInfoError ) {
      logger.info(
        `hasItem error for ${key}: ${e.message}`,
      );
    }
    throw e;
  }
  if ( !exists ) {
    return null;
  }

  try {
    const item = await getItem( key, options );
    return item?.value ?? null;
  } catch ( e ) {
    if ( e instanceof SensitiveInfoError && isDebugModeSync() ) {
      switch ( e.code ) {
        case ErrorCode.NotFound:
          // Value doesn't exist
          logger.info( `getItem not available for ${key}` );
          break;
        default:
          logger.info( `getItem unknown error for ${key}: ${e.message}` );
          break;
      }
    }
    throw e;
  }
}

async function setSensitiveItem( key: string, value: string, options = {} ) {
  const actualOptions = {
    // I put the key as overridable by actual options propped in,
    // in case someone wants to build a separate slice at one point.
    service: "app" as const,
    ...options,
    accessControl: "none" as const,
  };
  try {
    const result = await setItem( key, value, actualOptions );
    clearAuthCache( );
    return result;
  } catch ( e ) {
    if ( e instanceof SensitiveInfoError && isDebugModeSync( ) ) {
      logger.info(
        `setItem error for ${key}, ${e.code} ${e.message}`,
      );
    }
    throw e;
  }
}

async function deleteSensitiveItem(
  key: string,
  options = {
    service: "app" as const,
  },
) {
  try {
    const result = await deleteItem( key, options );
    clearAuthCache( );
    return result;
  } catch ( e ) {
    if ( e instanceof SensitiveInfoError && isDebugModeSync() ) {
      logger.info(
        `deleteItem error for ${key}, ${e.code} ${e.message}`,
      );
    }
    throw e;
  }
}

// Every request here is a small JSON call, so anything near this is a request
// that is never coming back. Unbounded was the dangerous default for the token
// refresh in particular: getJWT hands every concurrent caller the same
// in-flight jwtRefreshPromise, so one hung /users/api_token.json would leave
// every authenticated query in the app waiting on it for as long as iOS kept
// the socket open.
const API_TIMEOUT_MS = 30_000;

/**
 * Creates base API client for all requests
 * @param additionalHeaders any additional headers that will be passed to the API
 */
const createAPI = ( additionalHeaders?: { [header: string]: string } ) => create( {
  baseURL: API_HOST,
  timeout: API_TIMEOUT_MS,
  headers: {
    "User-Agent": getUserAgent(),
    "X-Installation-ID": getInstallID( ),
    ...additionalHeaders,
  },
} );

/**
 * Returns whether we're currently logged in.
 *
 * @returns {Promise<boolean>}
 */
const isLoggedIn = async (): Promise<boolean> => {
  const now = Date.now();

  // if cached value is fresh, return it before checking storage
  if (
    authCache.isLoggedIn !== null
    && authCache.lastChecked
    && ( now - authCache.lastChecked ) < authCache.cacheTimeout
  ) {
    return authCache.isLoggedIn;
  }

  try {
    const accessToken = await getSensitiveItem( "accessToken" );
    const result = typeof accessToken === "string";

    // Keychain items are only readable while the device is unlocked, and the
    // read comes back *absent* rather than failing when it isn't: nothing
    // distinguishes "signed out" from "locked" at this level except that only
    // the second can happen while the app is in the background. Answering
    // false there is what made a backgrounded upload fail with "tried to
    // upload an observation without API token" and mark itself LOGIN_AGAIN
    // for a user who was signed in the whole time (Aug 8, 14 and 18 in the
    // app log, every one of them with appState=background). Only trust the
    // absence once this process has seen a token: signOut clears the cache,
    // so a real sign-out still reads as signed out.
    const backgrounded = AppState.currentState === "background"
      || AppState.currentState === "inactive";
    if ( !result && authCache.isLoggedIn && backgrounded ) {
      if ( now - lastKeychainUnreadableLoggedAt > KEYCHAIN_UNREADABLE_LOG_INTERVAL_MS ) {
        lastKeychainUnreadableLoggedAt = now;
        logger.warn(
          `isLoggedIn: no access token while appState=${AppState.currentState}; `
          + "treating the keychain as unreadable rather than signed out",
        );
      }
      // Cached as normal so a background upload of many observations doesn't
      // re-read the keychain for every one of them.
      authCache.lastChecked = now;
      return true;
    }

    authCache.isLoggedIn = result;
    authCache.lastChecked = now;

    return result;
  } catch ( error ) {
    console.warn( "Auth check failed:", error );
    // A keychain read that threw says nothing about whether we're signed in,
    // and answering false sends a signed-in user to the login screen (getJWT
    // returns null, and the upload path reads a null token as "log in again").
    // Keep the last answer we actually got from storage, stale or not.
    return authCache.isLoggedIn ?? false;
  }
};

/**
 * Signs out the user
 *
 * @returns {Promise<void>}
 */
const signOut = async (
  options: {
    realm?: Realm;
    clearRealm?: boolean;
    queryClient?: QueryClient;
  } = {
    clearRealm: false,
    queryClient: undefined,
  },
) => {
  // This makes sure also any cookies will be deleted too (MOB-589)
  const apiClient = createAPI();
  // Don't await on this endpoint, to not delay the signout process
  apiClient.get( "/logout" );

  // Delete the React Query cache. FWIW, this should *not* be optional, but
  // the checkForSignedInUser needs to call this and that doesn't have access
  // to the React Query context (maybe it could...)
  options.queryClient?.getQueryCache( ).clear( );

  // Disable firebase data collection on signout
  setFirebaseDataCollectionEnabled( false );

  // switch the app back to the system locale when a user signs out
  const systemLocale = getInatLocaleFromSystemLocale( );
  changeLanguage( systemLocale );

  await deleteSensitiveItem( "jwtToken" );
  await deleteSensitiveItem( "jwtGeneratedAt" );
  await deleteSensitiveItem( "username" );
  await deleteSensitiveItem( "accessToken" );

  // clear all directories containing user generated data within Documents Directory
  await removeAllFilesFromDirectory( computerVisionPath );
  await removeAllFilesFromDirectory( photoLibraryPhotosPath );
  await removeAllFilesFromDirectory( photoUploadPath );
  await removeAllFilesFromDirectory( rotatedOriginalPhotosPath );
  await removeAllFilesFromDirectory( soundUploadPath );

  await removeAllFilesFromDirectory( logFileDirectory );

  // delete all keys from mmkv
  zustandMMKVBackingStorage.clearAll( );

  if ( options.clearRealm ) {
    if ( options.realm ) {
      // Delete all the records in the realm db, including the ones accessible
      // through the copy of realm provided by RealmProvider
      options.realm.beginTransaction();
      try {
        options.realm.deleteAll();
        options.realm.commitTransaction();
      } catch ( _realmError ) {
        options.realm.cancelTransaction();
        // If we failed to wipe all the data in realm, delete the realm file.
        // Note that deleting the realm file *all* the time seems to cause
        // problems in Android when the app is force quit, as in sometimes it
        // seems to just delete the file even if you didn't sign out
        Realm.deleteFile( realmConfig );
      }
    }
  }

  RNRestart.restart( );
};

/**
 * Encodes a JWT. Lifted from react-native-jwt-io
 * https://github.com/maxweb4u/react-native-jwt-io/blob/7f926da46ff536dbb531dd8ae7177ab4ff28c43f/src/jwt.js#L21
 */
const encodeJWT = ( payload: object, key: string, algorithm?: string ) => {
  algorithm = typeof algorithm !== "undefined"
    ? algorithm
    : "HS256";
  return rs.jws.JWS.sign(
    algorithm,
    JSON.stringify( { alg: algorithm, typ: "JWT" } ),
    JSON.stringify( payload ),
    key,
  );
};

/**
 * Returns the access token to be used in case of an anonymous JWT (e.g. used
 * when getting taxon suggestions)
 * @returns encoded anonymous JWT
 */
const getAnonymousJWT = (): string => {
  const claims = {
    application: Platform.OS,
    exp: Date.now() / 1000 + 300,
  };

  return encodeJWT( claims, Config.JWT_ANONYMOUS_API_SECRET || "not-a-real-secret", "HS512" );
};

// A failed refresh means one of two very different things: the server rejected
// our credentials, or we never reached it. Only the first says anything about
// the token we already hold — see getJWT.
interface JWTRefreshResult {
  token: string | null;
  credentialsRejected: boolean;
}

// Shared promise for any in-flight token refresh. Concurrent callers that
// find the token stale will all await this same request rather than each
// firing their own, preventing a ton of requests against /users/api_token.json
// during downtime.
let jwtRefreshPromise: Promise<JWTRefreshResult> | null = null;

const jwtRefreshBackoffRemainingMs = ( ): number => {
  if ( !jwtRefreshFailedAt || jwtRefreshFailureCount === 0 ) { return 0; }
  const backoff = Math.min(
    // 2^1, 2^2, 2^3........
    JWT_REFRESH_BACKOFF_BASE_MS * 2 ** ( jwtRefreshFailureCount - 1 ),
    JWT_REFRESH_BACKOFF_MAX_MS,
  );
  return Math.max( backoff - ( Date.now( ) - jwtRefreshFailedAt ), 0 );
};

const recordJwtRefreshFailure = ( ): void => {
  jwtRefreshFailureCount += 1;
  jwtRefreshFailedAt = Date.now( );
};

const recordJwtRefreshSuccess = ( ): void => {
  jwtRefreshFailureCount = 0;
  jwtRefreshFailedAt = null;
};

async function fetchFreshJWT( logContext: string | null ): Promise<JWTRefreshResult> {
  try {
    const accessToken = await getSensitiveItem( "accessToken" );
    // accessToken is normally a string here, since we're logged in, i.e. in the
    // call to isLoggedIn() above we must have found accessToken to not be null
    // at least in the last 5000 ms. But that cache can be up to 5s stale and the
    // read can fail on its own, and sending `Bearer null` earns a 401 that we
    // would then read as the server rejecting real credentials — pushing the
    // user to the login screen over a storage hiccup.
    if ( typeof accessToken !== "string" ) {
      // Backgrounded, this is the locked-device keychain read isLoggedIn
      // describes above rather than a missing login, and it resolves itself
      // when the device is unlocked -- not worth an error line per upload.
      const message = `JWT [${logContext}]: No access token to refresh with `
        + `(appState=${AppState.currentState})`;
      if ( AppState.currentState === "background" || AppState.currentState === "inactive" ) {
        logger.warn( message );
      } else {
        logger.error( message );
      }
      return { token: null, credentialsRejected: false };
    }
    const api = createAPI( { Authorization: `Bearer ${accessToken}` } );
    let response;
    try {
      response = await api.get<{api_token: string}>( "/users/api_token.json" );
    } catch ( getUsersApiTokenError ) {
      logger.error( "Failed to fetch JWT: ", getUsersApiTokenError );
      recordJwtRefreshFailure( );
      if ( !getUsersApiTokenError ) {
        return { token: null, credentialsRejected: false };
      }
      throw getUsersApiTokenError;
    }

    if ( !response.ok ) {
      logger.error(
        `JWT [${logContext}]: Token refresh failed - status: ${response.status}`,
        `- originalError: ${response.originalError} - problem: ${response.problem}`,
      );
      recordJwtRefreshFailure( );
      // this deletes the user JWT and saved login details when a user is not
      // actually signed in anymore for example, if they installed, deleted,
      // and reinstalled the app without logging out
      const credentialsRejected = response.status === 401;
      if ( credentialsRejected ) {
        if ( logContext ) {
          logger.info( `JWT [${logContext}]: User unauthorized, navigating to login` );
        }
        if ( navigationRef.isReady( ) ) {
          navigationRef.navigate( "LoginStackNavigator", { screen: "Login" } );
        }
      }
      return { token: null, credentialsRejected };
    }

    // Get newest JWT Token
    const newJwtToken = response.data?.api_token;
    if ( !newJwtToken ) {
      recordJwtRefreshFailure( );
      throw new Error( "Fetched empty JWT" );
    }
    const newJwtGeneratedAt = Date.now();

    await setSensitiveItem( "jwtToken", newJwtToken );
    await setSensitiveItem( "jwtGeneratedAt", newJwtGeneratedAt.toString() );

    recordJwtRefreshSuccess( );

    if ( logContext ) {
      logger.info( `JWT [${logContext}]: Token refreshed successfully` );
    }

    return { token: newJwtToken, credentialsRejected: false };
  } finally {
    jwtRefreshPromise = null;
  }
}

/**
 * Returns most recent JWT (JSON Web Token) for API authentication - renews the token if necessary
 *
 * @param allowAnonymousJWT (optional=false) if true and user is not
 *  logged-in, use anonymous JWT
 * @returns {Promise<string|*>}
 */
const getJWT = async (
  allowAnonymousJWT = false,
  logContext: string | null = null,
): Promise<string | null> => {
  const jwtToken: string | null | undefined = await getSensitiveItem( "jwtToken" );
  const storedJwtGeneratedAt = await getSensitiveItem( "jwtGeneratedAt" );
  let jwtGeneratedAt: number | null = null;
  if ( storedJwtGeneratedAt ) {
    jwtGeneratedAt = parseInt( storedJwtGeneratedAt, 10 );
  }

  const loggedIn = await isLoggedIn();

  if ( !loggedIn && allowAnonymousJWT ) {
    // User not logged in, and anonymous JWT is allowed - return it
    if ( logContext ) {
      logger.info( `JWT [${logContext}]: Using anonymous JWT for non-logged-in user` );
    }
    return getAnonymousJWT();
  }

  if ( !loggedIn ) {
    if ( logContext ) {
      logger.info( `JWT [${logContext}]: User not logged in, returning null` );
    }
    return null;
  }

  if (
    !jwtToken
    || ( jwtGeneratedAt && ( Date.now() - jwtGeneratedAt ) / 1000 > JWT_EXPIRATION_MINS * 60 )
  ) {
    // JWT Tokens expire after 30 mins - if the token is non-existent or older
    // than 25 mins (safe margin) - ask for a new one.
    // If a refresh is already in-flight, return that shared promise instead
    // of starting a second concurrent request.
    if ( !jwtRefreshPromise ) {
      // skip the fetch (and return null) if we're still waiting on backoff
      if ( jwtRefreshBackoffRemainingMs() > 0 ) {
        return jwtToken ?? null;
      }
      jwtRefreshPromise = fetchFreshJWT( logContext );
    }
    const refresh = await jwtRefreshPromise;
    if ( refresh.token ) return refresh.token;
    // A refresh that failed because the API was unreachable says nothing about
    // the token we already hold, and we refresh at JWT_EXPIRATION_MINS against
    // a far longer real lifetime, so a token that just crossed that line is
    // very likely still good. Returning null here instead hands the caller
    // api_token: null and sends an authenticated request that can only 401 —
    // the app log has two "Token refresh failed - problem: NETWORK_ERROR" and
    // a 401 on fetchObservationUpdates with a null token. A 401 on the refresh
    // itself is the other case: those credentials really are dead, so there is
    // nothing to fall back to.
    const stillWithinRealLifetime = !!jwtGeneratedAt
      && ( Date.now() - jwtGeneratedAt ) / 1000 < JWT_ACTUAL_EXPIRATION_MINS * 60;
    if ( jwtToken && !refresh.credentialsRejected && stillWithinRealLifetime ) {
      if ( logContext ) {
        logger.info(
          `JWT [${logContext}]: Refresh unreachable, reusing the stored token for now`,
        );
      }
      return jwtToken;
    }
    return null;
  }
  // Current JWT token is still fresh/valid - return it as-is
  return jwtToken;
};

const showErrorAlert = ( errorText: string ) => {
  Alert.alert(
    "",
    errorText,
  );
};

interface RailsApiResponse {
  error_description?: string;
}

interface OauthTokenResponse extends RailsApiResponse {
  access_token?: string;
}

function errorDescriptionFromResponse( response: ApiResponse<OauthTokenResponse> ): string {
  let errorDescription = response.data?.error_description;
  if ( !errorDescription && response.problem === "NETWORK_ERROR" ) {
    errorDescription = i18next.t( "You-need-an-Internet-connection-to-do-that" );
  }
  if ( errorDescription ) return errorDescription;
  logger.error( "Indescribable error response", JSON.stringify( response ) );
  return i18next.t( "Something-went-wrong" );
}

interface UsersEditResponse extends RailsApiResponse {
  id: number;
  login: string;
  name?: string;
}

interface UserDetails {
  accessToken: string;
  username: string;
  userId: number;
}

async function afterVerifyCredentials(
  tokenResponse: ApiResponse<OauthTokenResponse>,
  apiClient: ApisauceInstance,
): Promise<UserDetails | null> {
  if ( !tokenResponse.ok ) {
    showErrorAlert( errorDescriptionFromResponse( tokenResponse ) );
    return null;
  }

  // Upgrade to the access token
  const accessToken = tokenResponse.data?.access_token;
  if ( !accessToken ) throw new Error( "Fetched empty OAuth access token" );

  // Next, find the iNat username (since we currently only have the FB/Google email)
  const usersEditResponse = await apiClient.get<UsersEditResponse>(
    "/users/edit.json",
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": getUserAgent( ),
      },
    },
  );

  if ( !usersEditResponse.ok ) {
    showErrorAlert( errorDescriptionFromResponse( usersEditResponse ) );
    if ( usersEditResponse.problem !== "CLIENT_ERROR" ) {
      console.error(
        "verifyCredentials failed when calling /users/edit.json - ",
        usersEditResponse.problem,
        usersEditResponse.status,
      );
    }

    return null;
  }

  const iNatUsername = usersEditResponse.data?.login;
  const iNatID = usersEditResponse.data?.id;

  if ( !iNatUsername ) throw new Error( "Fetch user without a login" );
  if ( !iNatID ) throw new Error( "Fetch user without an id" );

  return {
    accessToken,
    username: iNatUsername,
    userId: iNatID,
  };
}

/**
 * Verifies login credentials
 *
 * @param username
 * @param password
 * @return null in case of error, otherwise an object of accessToken,
 *  username (=iNaturalist username)
 */
async function verifyCredentials(
  username: string,
  password: string,
): Promise<UserDetails | null> {
  const formData = {
    format: "json",
    grant_type: "password",
    client_id: Config.OAUTH_CLIENT_ID,
    client_secret: Config.OAUTH_CLIENT_SECRET,
    password,
    username,
    locale: i18next.language,
  };

  const apiClient = createAPI();

  // This makes sure also any cookies will be deleted too (MOB-589)
  try {
    await apiClient.get( "/logout" );
  } catch ( error ) {
    console.log( "Error logging out:", error.message );
  }

  const tokenResponse = await apiClient.post<OauthTokenResponse>( "/oauth/token", formData );

  return afterVerifyCredentials( tokenResponse, apiClient );
}

export type AuthenticateUserResult =
| { success: true; observationsCount?: number }
| { success: false };

async function afterAuthenticateUser(
  userDetails: UserDetails | null,
  realm: Realm,
): Promise<AuthenticateUserResult> {
  if ( !userDetails ) {
    return { success: false };
  }

  const { userId, username: remoteUsername, accessToken } = userDetails;
  if ( !userId ) {
    return { success: false };
  }

  // Save authentication details to secure storage
  await setSensitiveItem( "username", remoteUsername );
  await setSensitiveItem( "accessToken", accessToken );

  // Save userId to local, encrypted storage
  const currentUser = { id: userId, login: remoteUsername, signedIn: true };

  // try to fetch user data (especially for loading user icon) from userMe
  const apiToken = await getJWT( );
  const options = {
    api_token: apiToken,
  };
  const remoteUser = await fetchUserMe( { }, options ) as ApiUser;
  const localUser = remoteUser
    ? {
      ...remoteUser,
      signedIn: true,
    }
    : currentUser;

  if ( remoteUser?.locale ) {
    // user locale preference from web should be saved to realm on sign in
    // and we can also update the app language from web
    changeLanguage( remoteUser?.locale );
  }

  if ( remoteUser ) {
    setFirebaseDataCollectionEnabled( !remoteUser.prefers_no_tracking );
  }

  safeRealmWrite( realm, ( ) => {
    realm.create( "User", localUser, UpdateMode.Modified );
  }, "saving current user in AuthenticationService" );
  clearAuthCache( );
  return {
    success: true,
    observationsCount: remoteUser?.observations_count,
  };
}

/**
 * Authenticates a user and saves authentication details to secure storage, to
 * be used when calling iNat APIs.
 *
 * @param username
 * @param password
 * @returns false in case of authentication error, true otherwise.
 */
const authenticateUser = async (
  username: string,
  password: string,
  realm: Realm,
): Promise<AuthenticateUserResult> => {
  const userDetails = await verifyCredentials( username, password );

  return afterAuthenticateUser( userDetails, realm );
};

async function authenticateUserByAssertion(
  assertionType: "apple" | "google",
  assertion: string,
  realm: Realm,
): Promise<AuthenticateUserResult> {
  const apiClient = createAPI( { Accept: "application/json" } );
  const formData = {
    client_id: Config.OAUTH_CLIENT_ID,
    client_secret: Config.OAUTH_CLIENT_SECRET,
    locale: i18next.language,
    assertion,
    assertion_type: assertionType,
  };
  const tokenResponse = await apiClient.post<OauthTokenResponse>(
    "/oauth/assertion_token",
    formData,
  );
  const userDetails = await afterVerifyCredentials( tokenResponse, apiClient );
  return afterAuthenticateUser( userDetails, realm );
}

interface CreateUserResponse {
  errors?: string[];
}

/**
 * Registers a new user
 *
 * @param email
 * @param username
 * @param password
 * @param license (optional)
 * @param time_zone (optional)
 *
 * @returns null if successful, otherwise an error string
 */
const registerUser = async ( user: { password: string } ) => {
  const locales = RNLocalize.getLocales();
  const formData = {
    user: {
      ...user,
      password_confirmation: user.password,
      locale: locales[0].languageCode,
    },
  };

  const api = createAPI();
  const response = await api.post<CreateUserResponse>( "/users.json", formData );

  if ( !response.ok ) {
    console.error(
      "registerUser failed when calling /users.json - ",
      response.problem,
      response.status,
    );
    return response.data?.errors?.[0];
  }

  return null;
};

const isCurrentUser = async ( username: string ): Promise<boolean> => {
  const currentUsername = await getSensitiveItem( "username" );
  return username === currentUsername;
};

interface ChangePasswordResponse {
  error?: string;
}

/**
 * Resets user password
 *
 * @param email
 *
 * @returns null if successful, otherwise an error string
 */
const resetPassword = async ( email: string ) => {
  const formData = {
    user: {
      email,
    },
  };

  const api = createAPI( );
  const response = await api.post<ChangePasswordResponse>( "/users/password", formData );

  // this endpoint doesn't exactly exist,
  // so it's expected to get a 404 Not found error back here
  if ( !response.ok ) {
    return response.data?.error;
  }

  return null;
};

/**
 * Check if an email is available for registration
 *
 * @param email
 *
 * @returns boolean if email is available or not
 */
const emailAvailable = async ( email: string ) => {
  // try to fetch user data (especially for loading user icon) from userMe
  const apiToken = await getAnonymousJWT( );
  const options = {
    api_token: apiToken,
  };
  const response = await fetchUserEmailAvailable( email, options ) as { available: boolean };
  return response?.available;
};

export {
  API_HOST,
  authenticateUser,
  authenticateUserByAssertion,
  clearAuthCache,
  emailAvailable,
  getAnonymousJWT,
  getJWT,
  isCurrentUser,
  isLoggedIn,
  registerUser,
  resetPassword,
  signOut,
};
