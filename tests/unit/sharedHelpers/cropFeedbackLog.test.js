import { recordCropFeedback } from "sharedHelpers/cropFeedbackLog";
import { zustandStorage } from "stores/useStore";

const readStoredFeedback = ( ) => {
  const raw = zustandStorage.getItem( "cropFeedbackLog" );
  return raw ? JSON.parse( raw ) : {};
};

describe( "cropFeedbackLog", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    zustandStorage.removeItem( "cropFeedbackLog" );
  } );

  it( "records kept crops and deleted images", ( ) => {
    recordCropFeedback( "file:///original.jpg", {
      crop: {
        x: 0.1, y: 0.2, w: 0.3, h: 0.3,
      },
      kept: true,
    } );
    recordCropFeedback( "file:///removed.jpg", {
      crop: null,
      kept: false,
    } );

    const stored = readStoredFeedback( );
    expect( stored["file:///original.jpg"] ).toMatchObject( {
      sourceKey: "file:///original.jpg",
      crop: {
        x: 0.1, y: 0.2, w: 0.3, h: 0.3,
      },
      kept: true,
    } );
    expect( stored["file:///removed.jpg"] ).toMatchObject( {
      sourceKey: "file:///removed.jpg",
      crop: null,
      kept: false,
    } );
  } );

  it( "ignores an empty source key", ( ) => {
    recordCropFeedback( "", { crop: null, kept: false } );
    expect( readStoredFeedback( ) ).toEqual( {} );
  } );
} );
