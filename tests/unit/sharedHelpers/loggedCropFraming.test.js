import { Image } from "react-native";
import { getAnimalCrop, saveAnimalCrop } from "sharedHelpers/animalCropLog";
import detectSubjectInImage from "sharedHelpers/detectSubjectInImage";
import { resolveSubjectDetectionForUri } from "sharedHelpers/useSubjectDetectionForUri";
import { zustandStorage } from "stores/useStore";

jest.mock( "sharedHelpers/detectSubjectInImage", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => Promise.resolve( {
    x: 0, y: 0, w: 1, h: 1,
  } ) ),
} ) );

jest.mock( "sharedHelpers/ensureLocalImageForCrop", ( ) => ( {
  __esModule: true,
  default: jest.fn( uri => Promise.resolve( uri ) ),
} ) );

const CROP = {
  x: 0.25, y: 0.3, w: 0.4, h: 0.2,
};

describe( "framing a photo by hand", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    zustandStorage.removeItem( "animalCropLog" );
    global.fetch = jest.fn( ( ) => Promise.resolve( { ok: true } ) );
    jest.spyOn( Image, "getSize" ).mockImplementation( ( _uri, onSuccess ) => {
      onSuccess( 2000, 1000 );
    } );
  } );

  it( "finds a crop saved under one photo size when looked up under another", ( ) => {
    // The media viewer frames the original; the Add an ID screen looks up the
    // medium URL for the same photo.
    saveAnimalCrop( "https://example.com/photos/1/original.jpeg", CROP );

    expect( getAnimalCrop( "https://example.com/photos/1/medium.jpeg" ) )
      .toMatchObject( CROP );
  } );

  it( "frames to a hand-made crop without running the subject detector", async ( ) => {
    saveAnimalCrop( "https://example.com/photos/2/original.jpeg", CROP );

    const detection = await resolveSubjectDetectionForUri(
      "https://example.com/photos/2/medium.jpeg",
      { loggedCropOnly: true },
    );

    expect( detection ).toMatchObject( {
      crop: CROP,
      imageWidth: 2000,
      imageHeight: 1000,
    } );
    expect( detectSubjectInImage ).not.toHaveBeenCalled( );
  } );

  it( "leaves an unframed photo alone rather than detecting a subject", async ( ) => {
    const detection = await resolveSubjectDetectionForUri(
      "https://example.com/photos/3/medium.jpeg",
      { loggedCropOnly: true },
    );

    expect( detection ).toBeNull( );
    expect( detectSubjectInImage ).not.toHaveBeenCalled( );
  } );
} );
