import Clipboard from "@react-native-clipboard/clipboard";
import { Alert } from "react-native";
import {
  copyCropFeedbackToClipboard,
  getCropFeedbackExportObject,
  linkCropFeedbackUploadedUrl,
  recordCropFeedback,
} from "sharedHelpers/cropFeedbackLog";
import { zustandStorage } from "stores/useStore";

jest.mock( "@react-native-clipboard/clipboard", ( ) => ( {
  setString: jest.fn( ),
} ) );

describe( "cropFeedbackLog", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    zustandStorage.removeItem( "cropFeedbackLog" );
    jest.spyOn( Alert, "alert" ).mockImplementation( ( ) => undefined );
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

    expect( getCropFeedbackExportObject( ) ).toEqual( {
      "file:///original.jpg": {
        crop: {
          x: 0.1, y: 0.2, w: 0.3, h: 0.3,
        },
        kept: true,
      },
      "file:///removed.jpg": {
        crop: null,
        kept: false,
      },
    } );
  } );

  it( "prefers uploaded URLs in the exported JSON", ( ) => {
    recordCropFeedback( "file:///original.jpg", {
      crop: {
        x: 0.1, y: 0.2, w: 0.3, h: 0.3,
      },
      kept: true,
    } );
    linkCropFeedbackUploadedUrl(
      "file:///original.jpg",
      "https://static.inaturalist.org/photos/123/square.jpg",
    );

    expect( getCropFeedbackExportObject( ) ).toEqual( {
      "https://static.inaturalist.org/photos/123/square.jpg": {
        crop: {
          x: 0.1, y: 0.2, w: 0.3, h: 0.3,
        },
        kept: true,
      },
    } );
  } );

  it( "copies exported JSON to the clipboard", ( ) => {
    recordCropFeedback( "file:///original.jpg", {
      crop: {
        x: 0.1, y: 0.2, w: 0.3, h: 0.3,
      },
      kept: true,
    } );

    copyCropFeedbackToClipboard( );

    expect( Clipboard.setString ).toHaveBeenCalledWith(
      JSON.stringify( {
        "file:///original.jpg": {
          crop: {
            x: 0.1, y: 0.2, w: 0.3, h: 0.3,
          },
          kept: true,
        },
      }, null, 2 ),
    );
    expect( Alert.alert ).toHaveBeenCalled( );
  } );
} );
