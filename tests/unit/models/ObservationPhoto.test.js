import ObservationPhoto from "realmModels/ObservationPhoto";

describe( "ObservationPhoto", ( ) => {
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

    it( "omits photo_id for position-only updates", ( ) => {
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
        },
      } );
    } );
  } );
} );
