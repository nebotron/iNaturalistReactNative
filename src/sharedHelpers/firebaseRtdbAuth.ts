import Config from "react-native-config";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "firebaseRtdbAuth" );

// The crop/brightness log database allows unauthenticated writes (so logging
// never breaks) but requires auth for reads. Signs in with the email/password
// user from .env (FIREBASE_API_KEY / FIREBASE_EMAIL / FIREBASE_PASSWORD) and
// caches the ID token until shortly before it expires.
let cached: { token: string; expiresAt: number } | null = null;

// Returns "?auth=<idToken>" to append to a Realtime Database REST URL, or ""
// when credentials aren't configured or sign-in fails (the request then just
// proceeds unauthenticated, which still works for writes).
const firebaseAuthQuery = async ( ): Promise<string> => {
  const apiKey = Config.FIREBASE_API_KEY;
  const email = Config.FIREBASE_EMAIL;
  const password = Config.FIREBASE_PASSWORD;
  if ( !apiKey || !email || !password ) return "";

  if ( cached && Date.now( ) < cached.expiresAt ) {
    return `?auth=${cached.token}`;
  }

  try {
    const res = await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
        + `?key=${encodeURIComponent( apiKey )}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify( { email, password, returnSecureToken: true } ),
      },
    );
    if ( !res.ok ) {
      logger.warn( "Firebase sign-in failed", res.status );
      return "";
    }
    const data = await res.json( );
    cached = {
      token: data.idToken,
      expiresAt: Date.now( ) + ( parseInt( data.expiresIn ?? "3600", 10 ) - 300 ) * 1000,
    };
    return `?auth=${cached.token}`;
  } catch ( err ) {
    logger.warn( "Firebase sign-in error", err );
    return "";
  }
};

export default firebaseAuthQuery;
