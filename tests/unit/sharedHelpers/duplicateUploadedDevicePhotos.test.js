import {
  getDevicePhotoUrisFromObservation,
  markDuplicatePhotosFromLibrary,
  recordUploadedDevicePhotoUris,
} from "sharedHelpers/duplicateUploadedDevicePhotos";

jest.mock( "sharedHelpers/getOriginalDevicePhotoUri", ( ) => ( {
  getGalleryAssetDevicePhotoUri: jest.fn( asset => asset.originalPath || asset.uri ),
  getOriginalDevicePhotoUri: jest.fn( asset => asset.originalPath || asset.uri ),
  normalizeDevicePhotoUri: jest.fn( uri => uri ),
} ) );

describe( "duplicateUploadedDevicePhotos", ( ) => {
  describe( "getDevicePhotoUrisFromObservation", ( ) => {
    it( "returns original device photo URIs from observation photos", ( ) => {
      expect( getDevicePhotoUrisFromObservation( {
        observationPhotos: [
          { originalDevicePhotoUri: "ph://ABC" },
          { originalDevicePhotoUri: undefined },
          { originalDevicePhotoUri: "ph://DEF" },
        ],
      } ) ).toEqual( ["ph://ABC", "ph://DEF"] );
    } );
  } );

  describe( "markDuplicatePhotosFromLibrary", ( ) => {
    it( "marks photos that match previously uploaded device URIs", ( ) => {
      const realm = {
        objects: jest.fn( modelName => ( {
          filtered: jest.fn( ).mockReturnValue( modelName === "UploadedDevicePhotoUri"
            ? [{ uri: "ph://ALREADY-UPLOADED" }]
            : [] ),
        } ) ),
      };

      expect(
        markDuplicatePhotosFromLibrary( realm, [
          { image: { uri: "file:///moved-1.jpg" } },
          { image: { uri: "file:///moved-2.jpg" } },
        ], [
          { originalPath: "ph://ALREADY-UPLOADED" },
          { originalPath: "ph://NEW-PHOTO" },
        ] ),
      ).toEqual( [
        {
          image: { uri: "file:///moved-1.jpg" },
          isDuplicateUpload: true,
          originalDevicePhotoUri: "ph://ALREADY-UPLOADED",
        },
        {
          image: { uri: "file:///moved-2.jpg" },
          isDuplicateUpload: false,
          originalDevicePhotoUri: "ph://NEW-PHOTO",
        },
      ] );
    } );
  } );

  describe( "recordUploadedDevicePhotoUris", ( ) => {
    it( "persists normalized device photo URIs in Realm", ( ) => {
      const create = jest.fn( );
      const realm = {
        isInTransaction: false,
        beginTransaction: jest.fn( ),
        commitTransaction: jest.fn( ),
        cancelTransaction: jest.fn( ),
        create,
      };

      recordUploadedDevicePhotoUris( realm, ["ph://UPLOADED-PHOTO"] );

      expect( create ).toHaveBeenCalledWith(
        "UploadedDevicePhotoUri",
        expect.objectContaining( { uri: "ph://UPLOADED-PHOTO" } ),
        "modified",
      );
    } );
  } );
} );
