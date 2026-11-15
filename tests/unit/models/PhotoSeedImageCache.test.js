import { photoUploadPath } from "appConstants/paths";
import { NativeModules } from "react-native";

const seedCache = jest.fn( );
NativeModules.FasterImageViewManager = { ...NativeModules.FasterImageViewManager, seedCache };

// eslint-disable-next-line global-require
const Photo = require( "realmModels/Photo" ).default;

const SQUARE_URL = "https://inaturalist-open-data.s3.amazonaws.com/photos/42/square.jpg";

// A synced photo is shown from its remote URL, so without seeding, the user's
// newest observations download the very bytes they just uploaded.
describe( "seedImageCache", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    seedCache.mockResolvedValue( true );
  } );

  it( "stores the uploaded file under the original, large and medium URLs", async ( ) => {
    await Photo.seedImageCache( SQUARE_URL, "/old/container/photoUploads/abc.jpg" );

    expect( seedCache ).toHaveBeenCalledWith(
      [
        "https://inaturalist-open-data.s3.amazonaws.com/photos/42/original.jpg",
        "https://inaturalist-open-data.s3.amazonaws.com/photos/42/large.jpg",
        "https://inaturalist-open-data.s3.amazonaws.com/photos/42/medium.jpg",
      ],
      // A bare path in the current container, not a file:// URI.
      `${photoUploadPath}/abc.jpg`,
    );
  } );

  it( "does nothing without a remote URL or a local file", async ( ) => {
    await Photo.seedImageCache( undefined, "photoUploads/abc.jpg" );
    await Photo.seedImageCache( SQUARE_URL, null );

    expect( seedCache ).not.toHaveBeenCalled( );
  } );

  it( "never fails the upload when seeding fails", async ( ) => {
    seedCache.mockRejectedValue( new Error( "disk full" ) );

    await expect(
      Photo.seedImageCache( SQUARE_URL, "photoUploads/abc.jpg" ),
    ).resolves.toBeUndefined( );
  } );
} );
