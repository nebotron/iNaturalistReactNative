import { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react-native";
import scoreImage from "api/computerVision";
import prefetchObservationSuggestions, {
  restartFailedOnlineSuggestions,
} from "sharedHelpers/prefetchObservationSuggestions";

jest.mock( "api/computerVision", ( ) => ( {
  __esModule: true,
  default: jest.fn( ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "jwt" ) ),
  isLoggedIn: jest.fn( ( ) => Promise.resolve( true ) ),
} ) );

jest.mock( "components/Suggestions/helpers/flattenUploadParams", ( ) => ( {
  __esModule: true,
  default: jest.fn( uri => Promise.resolve( { image: { uri } } ) ),
} ) );

jest.mock( "realmModels/ObservationPhoto", ( ) => ( {
  __esModule: true,
  default: { mapObsPhotoUris: observation => observation.photoUris },
} ) );

jest.mock( "realmModels/User", ( ) => ( {
  __esModule: true,
  default: { currentUser: ( ) => ( { id: 1 } ) },
} ) );

jest.mock( "sharedHelpers/animalCropLog", ( ) => ( {
  getAnimalCrop: ( ) => null,
} ) );

jest.mock( "sharedHooks/useSuggestions/useOfflineSuggestions", ( ) => ( {
  predictOffline: jest.fn( ( ) => Promise.resolve( null ) ),
} ) );

const mockCache = new Map( );
jest.mock( "sharedHelpers/suggestionsCache", ( ) => ( {
  ...jest.requireActual( "sharedHelpers/suggestionsCache" ),
  getCachedSuggestions: key => mockCache.get( key ),
  setCachedSuggestions: ( key, value ) => mockCache.set( key, value ),
} ) );

// Retry immediately so the tests don't wait on the real backoff
jest.mock( "sharedHelpers/logging", ( ) => ( {
  ...jest.requireActual( "sharedHelpers/logging" ),
  handleRetryDelay: ( ) => 0,
} ) );

const realm = {};
const response = { results: [] };
const networkError = ( ) => new TypeError( "Network request failed" );
const serverDown = ( ) => Object.assign( new Error( "Service Unavailable" ), { status: 503 } );

let photoCount = 0;
const makeObservation = ( ) => {
  photoCount += 1;
  return { photoUris: [`file:///photo-${photoCount}.jpg`] };
};

describe( "prefetchObservationSuggestions", ( ) => {
  let queryClient;

  beforeEach( ( ) => {
    queryClient = new QueryClient( );
    mockCache.clear( );
    scoreImage.mockReset( );
  } );

  afterEach( ( ) => {
    queryClient.clear( );
  } );

  it( "retries a failed online request", async ( ) => {
    scoreImage
      .mockRejectedValueOnce( networkError( ) )
      .mockResolvedValueOnce( response );

    await prefetchObservationSuggestions( queryClient, makeObservation( ), realm );

    expect( scoreImage ).toHaveBeenCalledTimes( 2 );
    expect( mockCache.size ).toBe( 1 );
  } );

  it( "sends one request when the same photo is prefetched twice at once", async ( ) => {
    scoreImage.mockResolvedValue( response );
    const observation = makeObservation( );

    await Promise.all( [
      prefetchObservationSuggestions( queryClient, observation, realm ),
      prefetchObservationSuggestions( queryClient, observation, realm ),
    ] );

    expect( scoreImage ).toHaveBeenCalledTimes( 1 );
  } );

  it( "doesn't resend a request that already succeeded in memory", async ( ) => {
    scoreImage.mockResolvedValue( response );
    const observation = makeObservation( );

    await prefetchObservationSuggestions( queryClient, observation, realm );
    // As if the persistent cache had been cleared or evicted
    mockCache.clear( );
    await prefetchObservationSuggestions( queryClient, observation, realm );

    expect( scoreImage ).toHaveBeenCalledTimes( 1 );
  } );

  it( "restarts only the requests that failed for good", async ( ) => {
    const failed = makeObservation( );
    const succeeded = makeObservation( );
    scoreImage.mockImplementation( params => (
      params.image.uri === failed.photoUris[0]
        ? Promise.reject( serverDown( ) )
        : Promise.resolve( response )
    ) );
    await prefetchObservationSuggestions( queryClient, failed, realm );
    await prefetchObservationSuggestions( queryClient, succeeded, realm );
    expect( scoreImage ).toHaveBeenCalledTimes( 2 );

    scoreImage.mockResolvedValue( response );
    const restarted = restartFailedOnlineSuggestions(
      queryClient,
      [failed, succeeded, makeObservation( )],
      realm,
    );

    expect( restarted ).toBe( 1 );
    await waitFor( ( ) => expect( scoreImage ).toHaveBeenCalledTimes( 3 ) );
    expect( scoreImage ).toHaveBeenLastCalledWith(
      expect.objectContaining( { image: { uri: failed.photoUris[0] } } ),
      expect.anything( ),
      expect.anything( ),
    );
  } );
} );
