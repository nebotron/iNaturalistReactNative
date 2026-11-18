import inatjs from "inaturalistjs";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Photo from "realmModels/Photo";

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( async ( ) => "jwt" ),
} ) );

describe( "ObservationPhoto", ( ) => {
  describe( "deletePhoto", ( ) => {
    const syncedObsPhoto = {
      uuid: "synced-obs-photo",
      _synced_at: new Date( ),
      photo: {
        url: "https://static.inaturalist.org/photos/1/square.jpg",
        localFilePath: "photoUploads/synced.jpg",
      },
    };
    const localObsPhoto = {
      uuid: "local-obs-photo",
      _synced_at: null,
      photo: { localFilePath: "photoUploads/local.jpg" },
    };
    const observation = { uuid: "obs", observationPhotos: [syncedObsPhoto, localObsPhoto] };

    beforeEach( ( ) => {
      jest.mocked( inatjs.observation_photos.delete ).mockReset( );
      jest.spyOn( Photo, "deletePhotoFromDeviceStorage" ).mockReset( ).mockResolvedValue( );
    } );

    it( "deletes an uploaded photo on the server when shown by its local file", async ( ) => {
      const localUri = Photo.getLocalPhotoUri( syncedObsPhoto.photo.localFilePath );
      await ObservationPhoto.deletePhoto( localUri, observation );
      expect( inatjs.observation_photos.delete ).toHaveBeenCalledWith(
        { id: "synced-obs-photo" },
        { api_token: "jwt" },
      );
      expect( Photo.deletePhotoFromDeviceStorage ).toHaveBeenCalledWith( localUri );
    } );

    it( "deletes an uploaded photo on the server when shown by a remote size", async ( ) => {
      await ObservationPhoto.deletePhoto(
        "https://static.inaturalist.org/photos/1/large.jpg",
        observation,
      );
      expect( inatjs.observation_photos.delete ).toHaveBeenCalledWith(
        { id: "synced-obs-photo" },
        expect.anything( ),
      );
    } );

    it( "does not call the server for a photo that was never uploaded", async ( ) => {
      await ObservationPhoto.deletePhoto(
        Photo.getLocalPhotoUri( localObsPhoto.photo.localFilePath ),
        observation,
      );
      expect( inatjs.observation_photos.delete ).not.toHaveBeenCalled( );
      expect( Photo.deletePhotoFromDeviceStorage ).toHaveBeenCalled( );
    } );

    it( "keeps the local photo when the server delete fails", async ( ) => {
      jest.mocked( inatjs.observation_photos.delete ).mockRejectedValue( new Error( "offline" ) );
      const localUri = Photo.getLocalPhotoUri( syncedObsPhoto.photo.localFilePath );
      await expect( ObservationPhoto.deletePhoto( localUri, observation ) ).rejects.toThrow( );
      expect( Photo.deletePhotoFromDeviceStorage ).not.toHaveBeenCalled( );
    } );

    it( "treats a photo already gone from the server as deleted", async ( ) => {
      // A 404 page isn't JSON, so the API layer rethrows the raw error.
      jest.mocked( inatjs.observation_photos.delete ).mockRejectedValue(
        Object.assign( new Error( "not found" ), {
          response: {
            status: 404,
            url: "u",
            json: async ( ) => { throw new Error( "JSON Parse error" ); },
          },
        } ),
      );
      const localUri = Photo.getLocalPhotoUri( syncedObsPhoto.photo.localFilePath );
      await ObservationPhoto.deletePhoto( localUri, observation );
      expect( Photo.deletePhotoFromDeviceStorage ).toHaveBeenCalledWith( localUri );
    } );
  } );

  describe( "createObsPhotosWithPosition", ( ) => {
    it( "retains a crop framed in the Group Photos grid", async ( ) => {
      const [obsPhoto] = await ObservationPhoto.createObsPhotosWithPosition(
        [{
          image: {
            uri: "file:///tmp/photoUploads/cropped.jpg",
            cropOriginalUri: "file:///tmp/photoUploads/original.jpg",
            crop: {
              x: 0.1, y: 0.2, w: 0.3, h: 0.3,
            },
          },
        }],
        { position: 0, local: false },
      );

      expect( obsPhoto.photo.cropOriginalLocalFilePath ).toEqual( "photoUploads/original.jpg" );
      expect( obsPhoto.photo ).toMatchObject( {
        cropX: 0.1,
        cropY: 0.2,
        cropW: 0.3,
        cropH: 0.3,
      } );
    } );

    it( "leaves crop metadata off an uncropped photo", async ( ) => {
      const [obsPhoto] = await ObservationPhoto.createObsPhotosWithPosition(
        [{ image: { uri: "file:///tmp/photoUploads/plain.jpg" } }],
        { position: 0, local: false },
      );

      expect( obsPhoto.photo.cropOriginalLocalFilePath ).toBeUndefined( );
      expect( obsPhoto.photo.cropX ).toBeUndefined( );
    } );
  } );

  describe( "mapPhotoForUpdating", ( ) => {
    it( "includes photo_id when the photo needs to be re-uploaded", ( ) => {
      const result = ObservationPhoto.mapPhotoForUpdating( 123, {
        uuid: "obs-photo-uuid",
        position: 0,
        photo: {
          id: 456,
          localFilePath: "file:///tmp/photoUploads/cropped.jpg",
          _synced_at: new Date( "2024-01-01T12:00:00Z" ),
          _updated_at: new Date( "2024-01-02T12:00:00Z" ),
        },
      } );

      expect( result ).toEqual( {
        id: "obs-photo-uuid",
        observation_photo: {
          observation_id: 123,
          position: 0,
          photo_id: 456,
        },
      } );
    } );

    // The photo is uploaded before the observation photo is updated, and the
    // upload marks the photo synced. Deciding here whether the photo was
    // re-uploaded therefore always came out false, and the id of the photo just
    // uploaded never reached the server -- the observation kept pointing at the
    // photo the crop replaced.
    it( "includes the new photo_id even though the re-upload marked it synced", ( ) => {
      const uploadedAt = new Date( "2024-01-03T12:00:00Z" );
      const result = ObservationPhoto.mapPhotoForUpdating( 123, {
        uuid: "obs-photo-uuid",
        position: 0,
        photo: {
          // id and _synced_at as markRecordUploaded leaves them after the
          // cropped file has been uploaded as a new photo
          id: 789,
          localFilePath: "file:///tmp/photoUploads/cropped.jpg",
          _synced_at: uploadedAt,
          _updated_at: new Date( "2024-01-02T12:00:00Z" ),
        },
      } );

      expect( result.observation_photo.photo_id ).toEqual( 789 );
    } );

    it( "sends the unchanged photo_id for position-only updates", ( ) => {
      const result = ObservationPhoto.mapPhotoForUpdating( 123, {
        uuid: "obs-photo-uuid",
        position: 1,
        photo: {
          id: 456,
          url: "https://example.com/square.jpg",
          _synced_at: new Date( ),
        },
      } );

      expect( result ).toEqual( {
        id: "obs-photo-uuid",
        observation_photo: {
          observation_id: 123,
          position: 1,
          photo_id: 456,
        },
      } );
    } );

    it( "omits photo_id when the photo has never been uploaded", ( ) => {
      const result = ObservationPhoto.mapPhotoForUpdating( 123, {
        uuid: "obs-photo-uuid",
        position: 1,
        photo: { localFilePath: "file:///tmp/photoUploads/new.jpg" },
      } );

      expect( result.observation_photo ).not.toHaveProperty( "photo_id" );
    } );
  } );

  describe( "mapObservationPhotoForMyObsDefaultMode", ( ) => {
    // My Observations draws from this mapping, so a photo cropped locally on an
    // already-uploaded observation has to keep resolving to its local file here.
    // It used to drop the timestamps hasLocalEdits reads, which made every photo
    // look unedited and sent the list back to the remote original -- the crop
    // looked lost the moment the observation was saved.
    it( "keeps a locally edited photo resolving to its local file", ( ) => {
      const mapped = ObservationPhoto.mapObservationPhotoForMyObsDefaultMode( {
        uuid: "obs-photo-uuid",
        photo: {
          url: "https://example.com/photos/1/square.jpg",
          localFilePath: "photoUploads/cropped.jpg",
          _synced_at: new Date( "2026-01-01T12:00:00Z" ),
          _updated_at: new Date( "2026-01-02T12:00:00Z" ),
        },
      } );

      expect( Photo.hasLocalEdits( mapped.photo ) ).toBe( true );
      expect( Photo.displayLocalOrRemoteOriginalPhoto( mapped.photo ) )
        .toMatch( /photoUploads\/cropped\.jpg$/ );
    } );

    it( "still prefers the remote photo when there are no local edits", ( ) => {
      const mapped = ObservationPhoto.mapObservationPhotoForMyObsDefaultMode( {
        uuid: "obs-photo-uuid",
        photo: {
          url: "https://example.com/photos/1/square.jpg",
          localFilePath: "photoUploads/uploaded.jpg",
          _synced_at: new Date( "2026-01-02T12:00:00Z" ),
          _updated_at: new Date( "2026-01-01T12:00:00Z" ),
        },
      } );

      expect( Photo.displayLocalOrRemoteOriginalPhoto( mapped.photo ) )
        .toEqual( "https://example.com/photos/1/original.jpg" );
    } );
  } );
} );
