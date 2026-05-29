import {
  deleteDevicePhotosRemovedDuringObservationPrep,
  resolveDevicePhotoUriForRemovedObservationPhoto,
  resolveDevicePhotoUriFromGroupedPhoto,
} from "sharedHelpers/deleteDevicePhotosDuringObservationPrep";

const mockDeleteOriginalDevicePhotos = jest.fn( async ( ) => undefined );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  deleteOriginalDevicePhotos: ( ...args ) => mockDeleteOriginalDevicePhotos( ...args ),
  __esModule: true,
  default: jest.fn( ( _uris, onComplete ) => onComplete( ) ),
} ) );

describe( "deleteDevicePhotosDuringObservationPrep", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "prefers explicit originalDevicePhotoUri on grouped photos", ( ) => {
    expect( resolveDevicePhotoUriFromGroupedPhoto( {
      originalDevicePhotoUri: "ph://EXPLICIT",
      image: { uri: "file:///cropped.jpg" },
    } ) ).toBe( "ph://EXPLICIT" );
  } );

  it( "falls back to asset id for grouped photos", ( ) => {
    expect( resolveDevicePhotoUriFromGroupedPhoto( {
      image: { uri: "file:///cropped.jpg", id: "ASSET-ID" },
    } ) ).toBe( "ph://ASSET-ID" );
  } );

  it( "resolves camera roll uris for removed camera photos", ( ) => {
    const observationPhotos = [
      { originalDevicePhotoUri: "ph://GALLERY" },
      { originalDevicePhotoUri: null },
      { originalDevicePhotoUri: null },
    ];

    expect( resolveDevicePhotoUriForRemovedObservationPhoto(
      observationPhotos[1],
      observationPhotos,
      1,
      ["ph://CAMERA-1", "ph://CAMERA-2"],
    ) ).toBe( "ph://CAMERA-1" );

    expect( resolveDevicePhotoUriForRemovedObservationPhoto(
      observationPhotos[2],
      observationPhotos,
      2,
      ["ph://CAMERA-1", "ph://CAMERA-2"],
    ) ).toBe( "ph://CAMERA-2" );
  } );

  it( "resolves device URIs from imported local file mappings", ( ) => {
    expect( resolveDevicePhotoUriForRemovedObservationPhoto(
      {
        originalPhotoUri: "file:///local/imported.jpg",
        photo: { localFilePath: "photoUploads/resized.jpg" },
      },
      [{
        originalPhotoUri: "file:///local/imported.jpg",
        photo: { localFilePath: "photoUploads/resized.jpg" },
      }],
      0,
      [],
      { "file:///local/imported.jpg": "ph://MAPPED" },
    ) ).toBe( "ph://MAPPED" );
  } );

  it( "deletes unique device photo uris", ( ) => {
    deleteDevicePhotosRemovedDuringObservationPrep( [
      "ph://A",
      "ph://A",
      null,
    ] );

    expect( mockDeleteOriginalDevicePhotos ).toHaveBeenCalledWith(
      ["ph://A"],
      { userInitiated: true },
    );
  } );
} );
