import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import savePhotosToPhotoLibrary from "components/Camera/helpers/savePhotosToPhotoLibrary";
import faker from "tests/helpers/faker";

describe( "userPrepareStoreAndNavigate", ( ) => {
  describe( "savePhotosToPhotoLibrary", ( ) => {
    it( "should call CameraRoll.save three times when given three uris", async ( ) => {
      const uris = [
        faker.system.filePath( ),
        faker.system.filePath( ),
        faker.system.filePath( ),
      ];
      const mockOnEachSuccess = jest.fn( );
      await savePhotosToPhotoLibrary( uris, mockOnEachSuccess );
      const cameraRollSaveFirstArgs = CameraRoll.saveAsset.mock.calls.map( args => args[0] );
      expect( cameraRollSaveFirstArgs ).toEqual( uris );
    } );
  } );
} );
