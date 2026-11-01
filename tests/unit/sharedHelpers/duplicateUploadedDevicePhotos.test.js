import {
  getDevicePhotoUrisFromObservation,
  getPreviouslyUploadedDevicePhotoUrisSet,
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

  describe( "getPreviouslyUploadedDevicePhotoUrisSet", ( ) => {
    it( "collects device photo URIs from uploaded observations", ( ) => {
      const realm = {
        objects: jest.fn( modelName => {
          if ( modelName === "UploadedDevicePhotoUri" ) {
            return [];
          }
          return {
            filtered: jest.fn( ).mockReturnValue( [
              {
                observationPhotos: [
                  { originalDevicePhotoUri: "ph://UPLOADED-1" },
                ],
              },
              {
                observationPhotos: [
                  { originalDevicePhotoUri: "ph://UPLOADED-2" },
                ],
              },
            ] ),
          };
        } ),
      };

      expect(
        getPreviouslyUploadedDevicePhotoUrisSet( realm ),
      ).toEqual( new Set( ["ph://UPLOADED-1", "ph://UPLOADED-2"] ) );
    } );

    it( "includes URIs stored in the uploaded device photo index", ( ) => {
      const realm = {
        objects: jest.fn( modelName => {
          if ( modelName === "UploadedDevicePhotoUri" ) {
            return [{ uri: "ph://INDEXED-PHOTO" }];
          }
          return {
            filtered: jest.fn( ).mockReturnValue( [] ),
          };
        } ),
      };

      expect(
        getPreviouslyUploadedDevicePhotoUrisSet( realm ),
      ).toEqual( new Set( ["ph://INDEXED-PHOTO"] ) );
    } );
  } );

  describe( "markDuplicatePhotosFromLibrary", ( ) => {
    it( "marks photos that match previously uploaded device URIs", ( ) => {
      const realm = {
        objects: jest.fn( modelName => {
          if ( modelName === "UploadedDevicePhotoUri" ) {
            return [{ uri: "ph://ALREADY-UPLOADED" }];
          }
          return {
            filtered: jest.fn( ).mockReturnValue( [] ),
          };
        } ),
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
