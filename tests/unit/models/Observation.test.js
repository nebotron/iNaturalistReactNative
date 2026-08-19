import * as Exify from "@lodev09/react-native-exify";
import Observation from "realmModels/Observation";
import ObservationFieldValue from "realmModels/ObservationFieldValue";
import ProjectObservation from "realmModels/ProjectObservation";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import factory from "tests/factory";
import * as uuid from "uuid";

describe( "Observation", ( ) => {
  describe( "mapObservationForUpload", ( ) => {
    // observed_on is set by the server, clients specify the date with observed_on_string
    it( "should not include observed_on", ( ) => {
      expect(
        Observation.mapObservationForUpload( { observed_on: "2020-01-01" } ).observed_on,
      ).toBeUndefined( );
    } );
  } );

  describe( "mapApiToRealm", ( ) => {
    it(
      "should assign user.prefers_community_taxa from user.preferences.prefers_community_taxa",
      ( ) => {
        const mockApiObservation = {
          user: {
            preferences: {
              prefers_community_taxa: false,
            },
          },
        };
        expect(
          Observation.mapApiToRealm( mockApiObservation ).user.prefers_community_taxa,
        ).toEqual( mockApiObservation.user.preferences.prefers_community_taxa );
      },
    );
    it( "should set _created_at to a date object without Realm", ( ) => {
      expect( Observation.mapApiToRealm( { } )._created_at ).toBeInstanceOf( Date );
    } );
    it( "should create observationSounds from observation_sounds", ( ) => {
      const remoteObservationSound = factory( "RemoteObservationSound" );
      const mappedObservation = Observation.mapApiToRealm( {
        observation_sounds: [remoteObservationSound],
      } );
      expect( mappedObservation.observationSounds[0].sound.file_url )
        .toEqual( remoteObservationSound.sound.file_url );
      expect( mappedObservation.observationSounds[0].uuid )
        .toEqual( remoteObservationSound.uuid );
    } );

    it( "should map project_observations to projectObservations with created_at metadata", ( ) => {
      const mockRemoteObservation = factory( "RemoteObservation", {
        project_observations: [factory( "RemoteProjectObservation" )],
      } );
      const mappedObservation = Observation.mapApiToRealm( mockRemoteObservation );
      expect( mappedObservation.projectObservations ).toHaveLength( 1 );
      expect( mappedObservation.projectObservations[0]._created_at ).toBeInstanceOf( Date );
    } );

    // The API never returns it, and the embedded photo list is replaced
    // wholesale on every sync, so without carrying it over an uploaded
    // observation loses the link to the photo in the device library the first
    // time it's downloaded again.
    it( "should keep the stored originalDevicePhotoUri the API doesn't return", ( ) => {
      const remoteObservationPhoto = factory( "RemoteObservationPhoto" );
      const realm = {
        objectForPrimaryKey: ( ) => ( {
          observationPhotos: [{
            uuid: remoteObservationPhoto.uuid,
            originalDevicePhotoUri: "ph://ABC/L0/001",
          }],
        } ),
      };
      const mappedObservation = Observation.mapApiToRealm( {
        uuid: "obs-uuid",
        observation_photos: [remoteObservationPhoto],
      }, realm );
      expect( mappedObservation.observationPhotos[0].originalDevicePhotoUri )
        .toEqual( "ph://ABC/L0/001" );
    } );

    it( "should map ofvs to observationFieldValues with created_at metadata", ( ) => {
      const mockRemoteObservation = factory( "RemoteObservation", {
        ofvs: [factory( "RemoteObservationFieldValue" )],
      } );
      const mappedObservation = Observation.mapApiToRealm( mockRemoteObservation );
      expect( mappedObservation.observationFieldValues ).toHaveLength( 1 );
      expect( mappedObservation.observationFieldValues[0]._created_at ).toBeInstanceOf( Date );
    } );
  } );

  describe( "upsertRemoteObservations", ( ) => {
    it( "should persist observationFieldValues in Realm", ( ) => {
      const mockRemoteObservation = factory( "RemoteObservation", {
        ofvs: [factory( "RemoteObservationFieldValue" )],
      } );

      Observation.upsertRemoteObservations( [mockRemoteObservation], global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", mockRemoteObservation.uuid );
      expect( obs.observationFieldValues ).toHaveLength( 1 );
      expect( obs.observationFieldValues[0].value ).toBe(
        mockRemoteObservation.ofvs[0].value,
      );
      expect( obs.observationFieldValues[0].obsFieldId ).toBe(
        mockRemoteObservation.ofvs[0].field_id,
      );
    } );

    it( "should persist projectObservations in Realm", ( ) => {
      const mockRemoteObservation = factory( "RemoteObservation", {
        project_observations: [factory( "RemoteProjectObservation" )],
      } );

      Observation.upsertRemoteObservations( [mockRemoteObservation], global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", mockRemoteObservation.uuid );
      expect( obs.projectObservations ).toHaveLength( 1 );
      expect( obs.projectObservations[0].id ).toBe(
        mockRemoteObservation.project_observations[0].id,
      );
      expect( obs.projectObservations[0].projectId ).toBe(
        mockRemoteObservation.project_observations[0].project_id,
      );
    } );
  } );

  describe( "needsSync", ( ) => {
    it.todo( "should need sync when a photo needs sync" );
    it.todo( "should need sync when a sound needs sync" );
    it( "should need sync when a project observation needs sync", ( ) => {
      const obsUuid = uuid.v4( );
      const syncDate = new Date( "2020-01-02" );
      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", {
          uuid: obsUuid,
          _synced_at: syncDate,
          _updated_at: syncDate,
          projectObservations: [ProjectObservation.new( 1 )],
        } );
      }, "create Observation with unsynced PO for needsSync test" );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.needsSync( ) ).toBe( true );
    } );

    it( "should need sync when an observation field value needs sync", ( ) => {
      const obsUuid = uuid.v4( );
      const syncDate = new Date( "2020-01-02" );
      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", {
          uuid: obsUuid,
          _synced_at: syncDate,
          _updated_at: syncDate,
          observationFieldValues: [
            ObservationFieldValue.new( 5, "x" ),
          ],
        } );
      }, "create Observation with unsynced OFV for needsSync test" );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.needsSync( ) ).toBe( true );
    } );
  } );

  describe( "filterUnsyncedObservations", ( ) => {
    it( "should include observations with unsynced project observations", ( ) => {
      const obsUuid = uuid.v4( );
      const syncDate = new Date( "2020-01-02" );
      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", {
          uuid: obsUuid,
          _synced_at: syncDate,
          _updated_at: syncDate,
          projectObservations: [ProjectObservation.new( 1 )],
        } );
      }, "create synced obs with unsynced PO" );

      const unsynced = Observation.filterUnsyncedObservations( global.realm );
      expect( unsynced.filtered( `uuid == "${obsUuid}"` ).length ).toBe( 1 );
    } );

    it( "should include observations with unsynced observation field values", ( ) => {
      const obsUuid = uuid.v4( );
      const syncDate = new Date( "2020-01-02" );
      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", {
          uuid: obsUuid,
          _synced_at: syncDate,
          _updated_at: syncDate,
          observationFieldValues: [
            ObservationFieldValue.new( 5, "x" ),
          ],
        } );
      }, "create synced obs with unsynced OFV" );

      const unsynced = Observation.filterUnsyncedObservations( global.realm );
      expect( unsynced.filtered( `uuid == "${obsUuid}"` ).length ).toBe( 1 );
    } );
  } );

  describe( "saveLocalObservationForUpload", ( ) => {
    it( "creates Realm tombstones from pending-removal POs", async ( ) => {
      const obsUuid = uuid.v4( );
      const syncedAt = new Date( "2020-01-02" );
      const poUuid = uuid.v4( ).toLowerCase( );

      const mockPO = factory( "LocalProjectObservation", {
        uuid: poUuid,
        _synced_at: syncedAt,
        _pendingRemoval: true,
      } );
      await Observation.saveLocalObservationForUpload( {
        uuid: obsUuid,
        projectObservations: [mockPO],
        observationFieldValues: [],
        observationPhotos: [],
        observationSounds: [],
      }, global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.projectObservations ).toHaveLength( 1 );
      expect( obs.projectObservations[0]._pending_deletion ).toBe( true );
      expect( obs.projectObservations[0].uuid ).toBe( poUuid );
      expect( obs.projectObservations[0]._synced_at ).toEqual( syncedAt );
    } );

    it( "creates Realm tombstones from pending-removal OFVs", async ( ) => {
      const obsUuid = uuid.v4( );
      const syncedAt = new Date( "2020-01-02" );
      const ofvUuid = uuid.v4( ).toLowerCase( );

      const mockOFV = factory( "LocalObservationFieldValue", {
        uuid: ofvUuid,
        _synced_at: syncedAt,
        _pendingRemoval: true,
      } );
      await Observation.saveLocalObservationForUpload( {
        uuid: obsUuid,
        projectObservations: [],
        observationFieldValues: [mockOFV],
        observationPhotos: [],
        observationSounds: [],
      }, global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.observationFieldValues ).toHaveLength( 1 );
      expect( obs.observationFieldValues[0]._pending_deletion ).toBe( true );
      expect( obs.observationFieldValues[0].uuid ).toBe( ofvUuid );
    } );

    it( "writes re-selected POs as active embeds without tombstones", async ( ) => {
      const obsUuid = uuid.v4( );
      const syncedAt = new Date( "2020-01-02" );
      const poUuid = uuid.v4( ).toLowerCase( );

      const mockPO = factory( "LocalProjectObservation", {
        uuid: poUuid,
        _synced_at: syncedAt,
        _pending_deletion: true,
      } );

      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", {
          uuid: obsUuid,
          _synced_at: syncedAt,
          _updated_at: syncedAt,
          projectObservations: [mockPO],
        } );
      }, "seed tombstoned PO for re-select save test" );

      delete mockPO._pending_deletion;
      await Observation.saveLocalObservationForUpload( {
        uuid: obsUuid,
        projectObservations: [mockPO],
        observationFieldValues: [],
        observationPhotos: [],
        observationSounds: [],
      }, global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.projectObservations[0]._pending_deletion ).toBeFalsy( );
      expect( obs.projectObservations[0]._synced_at ).toBeNull( );
    } );

    it( "leaves unchanged synced embed timestamps intact on re-edit", async ( ) => {
      const obsUuid = uuid.v4( );
      const syncedAt = new Date( "2020-01-02" );
      const poUuid = uuid.v4( ).toLowerCase( );
      const ofvUuid = uuid.v4( ).toLowerCase( );

      const mockPO = factory( "LocalProjectObservation", {
        uuid: poUuid,
        _synced_at: syncedAt,
      } );
      const mockOFV = factory( "LocalObservationFieldValue", {
        uuid: ofvUuid,
        _synced_at: syncedAt,
      } );
      const mockObs = factory( "LocalObservation", {
        uuid: obsUuid,
        projectObservations: [mockPO],
        observationFieldValues: [mockOFV],
        observationPhotos: [],
        observationSounds: [],
      } );

      safeRealmWrite( global.realm, ( ) => {
        global.realm.create( "Observation", mockObs );
      }, "seed synced PO/OFV for unchanged re-edit save test" );

      await Observation.saveLocalObservationForUpload( mockObs, global.realm );

      const obs = global.realm.objectForPrimaryKey( "Observation", obsUuid );
      expect( obs.projectObservations[0]._synced_at ).toEqual( syncedAt );
      expect( obs.observationFieldValues[0]._synced_at ).toEqual( syncedAt );
    } );

    it( "should index the device photos it was imported from", async ( ) => {
      const obsUuid = uuid.v4( );
      const devicePhotoUri = `ph://${uuid.v4( )}`;

      await Observation.saveLocalObservationForUpload( {
        uuid: obsUuid,
        observationPhotos: [{
          uuid: uuid.v4( ),
          position: 0,
          originalDevicePhotoUri: devicePhotoUri,
          photo: { uuid: uuid.v4( ), url: "file:///local.jpg" },
        }],
      }, global.realm );

      const indexed = global.realm.objects( "UploadedDevicePhotoUri" )
        .filtered( "uri == $0", devicePhotoUri );
      expect( indexed.length ).toBe( 1 );
    } );
  } );

  describe( "createObservationFromGalleryPhotos", ( ) => {
    const galleryPhoto = timestamp => ( {
      image: { uri: "file:///photo.jpg", timestamp },
    } );

    beforeEach( ( ) => {
      Exify.read.mockResolvedValue( undefined );
    } );

    it( "should use the photo's timestamp when it has no EXIF date", async ( ) => {
      const obs = await Observation.createObservationFromGalleryPhotos( [
        galleryPhoto( "1754467200" ),
      ] );
      // observed_on_string has no timezone, so it parses back as local time
      expect( new Date( obs.observed_on_string ).getTime( ) ).toEqual( 1754467200 * 1000 );
    } );

    it( "should treat a milliseconds timestamp as milliseconds", async ( ) => {
      const obs = await Observation.createObservationFromGalleryPhotos( [
        galleryPhoto( 1754467200000 ),
      ] );
      expect( new Date( obs.observed_on_string ).getTime( ) ).toEqual( 1754467200 * 1000 );
    } );

    it( "should prefer the EXIF date over the photo's timestamp", async ( ) => {
      Exify.read.mockResolvedValue( { DateTimeOriginal: "2018:03:07 08:19:49" } );
      const obs = await Observation.createObservationFromGalleryPhotos( [
        galleryPhoto( "1754467200" ),
      ] );
      expect( obs.observed_on_string ).toEqual( "2018-03-07T08:19:49" );
    } );

    it( "should leave the date unset when there is no EXIF date or timestamp", async ( ) => {
      const obs = await Observation.createObservationFromGalleryPhotos( [
        galleryPhoto( undefined ),
      ] );
      expect( obs.observed_on_string ).toBeFalsy( );
    } );

    // A camera with no GPS writes no GPS tags, and a location set by hand in
    // the Photos app is recorded against the asset, never written back into the
    // file we import.
    it( "should use the device asset's location when the photo has no GPS EXIF", async ( ) => {
      const obs = await Observation.createObservationFromGalleryPhotos( [{
        image: {
          uri: "file:///photo.jpg",
          timestamp: "1754467200",
          deviceLocation: { latitude: 38.07, longitude: -122.85 },
        },
      }] );
      expect( obs.latitude ).toEqual( 38.07 );
      expect( obs.longitude ).toEqual( -122.85 );
    } );

    it( "should prefer the device asset's location over the photo's GPS EXIF", async ( ) => {
      Exify.read.mockResolvedValue( {
        GPSLatitude: 1,
        GPSLongitude: 2,
        GPSHPositioningError: 5,
      } );
      const obs = await Observation.createObservationFromGalleryPhotos( [{
        image: {
          uri: "file:///photo.jpg",
          deviceLocation: { latitude: 38.07, longitude: -122.85 },
        },
      }] );
      expect( obs.latitude ).toEqual( 38.07 );
      expect( obs.longitude ).toEqual( -122.85 );
      // The camera's accuracy described the point the user moved away from
      expect( obs.positional_accuracy ).toBeUndefined( );
    } );

    it( "should keep the EXIF accuracy when the device location matches", async ( ) => {
      Exify.read.mockResolvedValue( {
        GPSLatitude: 38.07,
        GPSLongitude: 122.85,
        GPSLongitudeRef: "W",
        GPSHPositioningError: 5,
      } );
      const obs = await Observation.createObservationFromGalleryPhotos( [{
        image: {
          uri: "file:///photo.jpg",
          deviceLocation: { latitude: 38.07, longitude: -122.85 },
        },
      }] );
      expect( obs.positional_accuracy ).toEqual( 5 );
    } );

    it( "should throw rather than import a photo whose metadata cannot be read", async ( ) => {
      Exify.read.mockRejectedValue( new Error( "Invalid URI" ) );
      await expect(
        Observation.createObservationFromGalleryPhotos( [galleryPhoto( "1754467200" )] ),
      ).rejects.toThrow( );
    } );
  } );

  describe( "deleteLocalObservation", ( ) => {
    it( "should keep hiding the device photos it was imported from", async ( ) => {
      const obsUuid = uuid.v4( );
      const devicePhotoUri = `ph://${uuid.v4( )}`;
      await Observation.saveLocalObservationForUpload( {
        uuid: obsUuid,
        observationPhotos: [{
          uuid: uuid.v4( ),
          position: 0,
          originalDevicePhotoUri: devicePhotoUri,
          photo: { uuid: uuid.v4( ), url: "file:///local.jpg" },
        }],
      }, global.realm );

      Observation.deleteLocalObservation( global.realm, obsUuid );

      expect( global.realm.objectForPrimaryKey( "Observation", obsUuid ) ).toBeNull( );
      expect(
        getPreviouslyUploadedDevicePhotoUrisSet( global.realm ).has( devicePhotoUri ),
      ).toBe( true );
    } );
  } );
} );
