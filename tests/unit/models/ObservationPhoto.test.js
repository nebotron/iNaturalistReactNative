import ObservationPhoto from "realmModels/ObservationPhoto";

describe( "ObservationPhoto", ( ) => {
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
