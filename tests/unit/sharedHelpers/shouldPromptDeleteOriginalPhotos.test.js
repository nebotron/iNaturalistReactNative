const mockDeleteOriginalDevicePhotos = jest.fn( async ( ) => undefined );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  deleteOriginalDevicePhotos: ( ...args ) => mockDeleteOriginalDevicePhotos( ...args ),
  __esModule: true,
  default: jest.fn( ( _uris, onComplete ) => onComplete( ) ),
} ) );

import shouldPromptDeleteOriginalPhotos from "sharedHelpers/shouldPromptDeleteOriginalPhotos";
import useStore from "stores/useStore";

const initialStoreState = useStore.getState( );

describe( "shouldPromptDeleteOriginalPhotos", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useStore.setState( initialStoreState, true );
  } );

  it( "does not prompt when no photos were removed during editing", ( ) => {
    useStore.setState( {
      originalDevicePhotoUris: ["ph://IMPORTED-AND-KEPT"],
      removedOriginalDevicePhotoUris: [],
    } );

    expect( shouldPromptDeleteOriginalPhotos( ) ).toBe( false );
  } );

  it( "prompts when photos were removed from observations before saving", ( ) => {
    useStore.setState( {
      originalDevicePhotoUris: ["ph://A", "ph://B"],
      removedOriginalDevicePhotoUris: ["ph://B"],
    } );

    expect( shouldPromptDeleteOriginalPhotos( ) ).toBe( true );
  } );

  it( "deletes removed device photos immediately when deleting from a new observation", ( ) => {
    useStore.setState( {
      observations: [{
        observationPhotos: [{
          originalDevicePhotoUri: "ph://REMOVED",
          photo: { url: "file:///local/photo.jpg" },
        }],
      }],
      currentObservationIndex: 0,
      currentObservation: {
        observationPhotos: [{
          originalDevicePhotoUri: "ph://REMOVED",
          photo: { url: "file:///local/photo.jpg" },
        }],
      },
      originalDevicePhotoUris: ["ph://REMOVED"],
    } );

    useStore.getState( ).deletePhotoFromObservation( "file:///local/photo.jpg" );

    expect( useStore.getState( ).currentObservation?.observationPhotos ).toEqual( [] );
    expect( mockDeleteOriginalDevicePhotos ).toHaveBeenCalledWith(
      ["ph://REMOVED"],
      { userInitiated: true },
    );
    expect( useStore.getState( ).originalDevicePhotoUris ).toEqual( [] );
    expect( useStore.getState( ).removedOriginalDevicePhotoUris ).toEqual( [] );
    expect( shouldPromptDeleteOriginalPhotos( ) ).toBe( false );
  } );

  it( "deletes camera roll photos immediately when deleting a camera photo from a new observation", ( ) => {
    useStore.setState( {
      observations: [{
        observationPhotos: [{
          photo: { url: "file:///local/camera.jpg" },
        }],
      }],
      currentObservationIndex: 0,
      currentObservation: {
        observationPhotos: [{
          photo: { url: "file:///local/camera.jpg" },
        }],
      },
      cameraRollUris: ["ph://CAMERA-ROLL"],
    } );

    useStore.getState( ).deletePhotoFromObservation( "file:///local/camera.jpg" );

    expect( mockDeleteOriginalDevicePhotos ).toHaveBeenCalledWith(
      ["ph://CAMERA-ROLL"],
      { userInitiated: true },
    );
    expect( useStore.getState( ).cameraRollUris ).toEqual( [] );
  } );

  it( "does not delete from the device when removing a photo from a saved observation", ( ) => {
    useStore.setState( {
      observations: [{
        _created_at: new Date( ),
        observationPhotos: [{
          originalDevicePhotoUri: "ph://SAVED",
          photo: { url: "file:///local/photo.jpg" },
        }],
      }],
      currentObservationIndex: 0,
      currentObservation: {
        _created_at: new Date( ),
        observationPhotos: [{
          originalDevicePhotoUri: "ph://SAVED",
          photo: { url: "file:///local/photo.jpg" },
        }],
      },
    } );

    useStore.getState( ).deletePhotoFromObservation( "file:///local/photo.jpg" );

    expect( mockDeleteOriginalDevicePhotos ).not.toHaveBeenCalled( );
  } );
} );
