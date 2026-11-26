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
        objectForPrimaryKey: jest.fn( ( ) => null ),
      };

      recordUploadedDevicePhotoUris( realm, ["ph://UPLOADED-PHOTO"] );

      expect( create ).toHaveBeenCalledWith(
        "UploadedDevicePhotoUri",
        expect.objectContaining( { uri: "ph://UPLOADED-PHOTO" } ),
        "modified",
      );
    } );

    it( "leaves already indexed URIs alone, without opening a transaction", ( ) => {
      const create = jest.fn( );
      const realm = {
        isInTransaction: false,
        beginTransaction: jest.fn( ),
        commitTransaction: jest.fn( ),
        cancelTransaction: jest.fn( ),
        create,
        objectForPrimaryKey: jest.fn( ( ) => ( { uri: "ph://INDEXED" } ) ),
      };

      recordUploadedDevicePhotoUris( realm, ["ph://INDEXED", "ph://INDEXED"] );

      expect( create ).not.toHaveBeenCalled( );
      expect( realm.beginTransaction ).not.toHaveBeenCalled( );
    } );

    it( "creates only the URIs that are missing, once each", ( ) => {
      const create = jest.fn( );
      const realm = {
        isInTransaction: false,
        beginTransaction: jest.fn( ),
        commitTransaction: jest.fn( ),
        cancelTransaction: jest.fn( ),
        create,
        objectForPrimaryKey: jest.fn( ( _model, uri ) => ( uri === "ph://OLD"
          ? { uri }
          : null ) ),
      };

      recordUploadedDevicePhotoUris( realm, ["ph://OLD", "ph://NEW", "ph://NEW"] );

      expect( create ).toHaveBeenCalledTimes( 1 );
      expect( create ).toHaveBeenCalledWith(
        "UploadedDevicePhotoUri",
        expect.objectContaining( { uri: "ph://NEW" } ),
        "modified",
      );
    } );
  } );

  describe( "getPreviouslyUploadedDevicePhotoUrisSet caching", ( ) => {
    const listenableRealm = ( ) => {
      const listeners = [];
      const observations = [
        { observationPhotos: [{ originalDevicePhotoUri: "ph://OBS-1" }] },
      ];
      const results = items => Object.assign( items, {
        addListener: jest.fn( listener => listeners.push( listener ) ),
        removeListener: jest.fn( ),
        filtered: jest.fn( ( ) => observations ),
      } );
      const indexed = results( [] );
      const realm = {
        isClosed: false,
        isInTransaction: false,
        objects: jest.fn( modelName => ( modelName === "UploadedDevicePhotoUri"
          ? indexed
          : results( observations ) ) ),
        objectForPrimaryKey: jest.fn( ( ) => null ),
        beginTransaction: jest.fn( ),
        commitTransaction: jest.fn( ),
        cancelTransaction: jest.fn( ),
        create: jest.fn( ( _model, { uri } ) => indexed.push( { uri } ) ),
      };
      return {
        realm, observations, notify: ( ) => listeners.forEach( listener => listener( ) ),
      };
    };

    it( "walks the observations once until Realm reports a change", ( ) => {
      const { realm, observations, notify } = listenableRealm( );
      expect( getPreviouslyUploadedDevicePhotoUrisSet( realm ) )
        .toEqual( new Set( ["ph://OBS-1"] ) );

      observations.push( { observationPhotos: [{ originalDevicePhotoUri: "ph://OBS-2" }] } );
      expect( getPreviouslyUploadedDevicePhotoUrisSet( realm ) )
        .toEqual( new Set( ["ph://OBS-1"] ) );

      notify( );
      expect( getPreviouslyUploadedDevicePhotoUrisSet( realm ) )
        .toEqual( new Set( ["ph://OBS-1", "ph://OBS-2"] ) );
    } );

    it( "sees URIs recorded in the index straight away", ( ) => {
      const { realm } = listenableRealm( );
      getPreviouslyUploadedDevicePhotoUrisSet( realm );

      recordUploadedDevicePhotoUris( realm, ["ph://JUST-SAVED"] );

      expect( getPreviouslyUploadedDevicePhotoUrisSet( realm ) ).toContain( "ph://JUST-SAVED" );
    } );

    it( "hands out a copy that callers can change", ( ) => {
      const { realm } = listenableRealm( );
      getPreviouslyUploadedDevicePhotoUrisSet( realm ).add( "ph://MINE" );

      expect( getPreviouslyUploadedDevicePhotoUrisSet( realm ) ).not.toContain( "ph://MINE" );
    } );
  } );
} );
