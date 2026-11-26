import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import savePhotosToPhotoLibrary, {
  savePhotoToPhotoLibraryAtCapture,
} from "components/Camera/helpers/savePhotosToPhotoLibrary";
import { checkMultiple, RESULTS } from "react-native-permissions";

const location = { latitude: 1, longitude: 2, positional_accuracy: 5 };

const savedAsset = id => ( { node: { id, image: { uri: `ph://${id}` } } } );

const flushPromises = ( ) => new Promise( resolve => { setImmediate( resolve ); } );

describe( "savePhotosToPhotoLibrary", ( ) => {
  beforeEach( ( ) => {
    CameraRoll.saveAsset.mockReset( );
    CameraRoll.saveAsset.mockImplementation( uri => Promise.resolve(
      savedAsset( uri.split( "/" ).pop( ) ),
    ) );
  } );

  it( "saves a photo to the library when it's taken", async ( ) => {
    await savePhotoToPhotoLibraryAtCapture( "file:///taken-1.jpg", location );
    await flushPromises( );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      "file:///taken-1.jpg",
      expect.objectContaining( { latitude: 1, longitude: 2 } ),
    );
  } );

  it( "doesn't save photos saved at capture a second time", async ( ) => {
    await savePhotoToPhotoLibraryAtCapture( "file:///taken-2.jpg", null );
    const savedUris = await savePhotosToPhotoLibrary(
      ["file:///taken-2.jpg", "file:///not-saved-yet.jpg"],
      location,
    );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 2 );
    expect( CameraRoll.saveAsset.mock.calls.map( call => call[0] ) ).toEqual(
      ["file:///taken-2.jpg", "file:///not-saved-yet.jpg"],
    );
    expect( savedUris ).toEqual( ["ph://taken-2.jpg", "ph://not-saved-yet.jpg"] );
  } );

  it( "retries a photo whose save at capture failed", async ( ) => {
    CameraRoll.saveAsset.mockRejectedValueOnce( new Error( "busy" ) );
    await savePhotoToPhotoLibraryAtCapture( "file:///taken-3.jpg", null );
    await flushPromises( );
    const savedUris = await savePhotosToPhotoLibrary( ["file:///taken-3.jpg"], location );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 2 );
    expect( savedUris ).toEqual( ["ph://taken-3.jpg"] );
  } );

  it( "waits for the checkmark when permission hasn't been granted yet", async ( ) => {
    checkMultiple.mockResolvedValueOnce( {
      "ios.permission.PHOTO_LIBRARY_ADD_ONLY": RESULTS.DENIED,
      "android.permission.WRITE_EXTERNAL_STORAGE": RESULTS.DENIED,
      "android.permission.READ_EXTERNAL_STORAGE": RESULTS.DENIED,
    } );
    await savePhotoToPhotoLibraryAtCapture( "file:///taken-4.jpg", null );
    await flushPromises( );
    expect( CameraRoll.saveAsset ).not.toHaveBeenCalled( );
  } );
} );
