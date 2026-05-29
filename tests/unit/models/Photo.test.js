import Photo from "realmModels/Photo";

describe( "Photo", ( ) => {
  describe( "hasLocalEdits", ( ) => {
    it( "returns true when a local file was edited after the last sync", ( ) => {
      const syncedAt = new Date( "2024-01-01T12:00:00Z" );
      const updatedAt = new Date( "2024-01-02T12:00:00Z" );

      expect( Photo.hasLocalEdits( {
        localFilePath: "file:///tmp/photoUploads/cropped.jpg",
        _synced_at: syncedAt,
        _updated_at: updatedAt,
      } ) ).toBe( true );
    } );

    it( "returns false for remote-only photos", ( ) => {
      expect( Photo.hasLocalEdits( {
        url: "https://example.com/square.jpg",
        _synced_at: new Date( ),
      } ) ).toBe( false );
    } );
  } );

  describe( "displayLocalOrRemoteSquarePhoto", ( ) => {
    it( "prefers the edited local file over the remote url", ( ) => {
      const uri = Photo.displayLocalOrRemoteSquarePhoto( {
        url: "https://example.com/square.jpg",
        localFilePath: "file:///tmp/photoUploads/cropped.jpg",
        _synced_at: new Date( "2024-01-01T12:00:00Z" ),
        _updated_at: new Date( "2024-01-02T12:00:00Z" ),
      } );

      expect( uri ).toContain( "cropped.jpg" );
      expect( uri ).toMatch( /^file:\/\// );
    } );
  } );
} );
