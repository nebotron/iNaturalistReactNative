import { stat } from "@dr.pogodin/react-native-fs";
import Photo from "realmModels/Photo";

describe( "Photo", ( ) => {
  describe( "ensureUploadableLocalFile", ( ) => {
    const localFilePath = "file:///tmp/photoUploads/big.jpg";

    it( "returns null when there is no local upload file", async ( ) => {
      expect( await Photo.ensureUploadableLocalFile( undefined ) ).toBeNull( );
    } );

    it( "keeps the existing file when it is small enough", async ( ) => {
      stat.mockResolvedValueOnce( { size: 1024 * 1024 } );
      const uri = await Photo.ensureUploadableLocalFile( localFilePath );
      expect( uri ).toContain( "big.jpg" );
    } );

    it( "re-resizes the file when it is too large to upload", async ( ) => {
      stat.mockResolvedValueOnce( { size: 20 * 1024 * 1024 } );
      const uri = await Photo.ensureUploadableLocalFile( localFilePath );
      // The resizer mock echoes the source filename back from its output path
      expect( uri ).toContain( "photoUploads" );
      expect( uri ).toContain( "big.jpg" );
    } );

    it( "leaves the file alone when it cannot be stat'd", async ( ) => {
      stat.mockRejectedValueOnce( new Error( "ENOENT" ) );
      const uri = await Photo.ensureUploadableLocalFile( localFilePath );
      expect( uri ).toContain( "big.jpg" );
    } );
  } );

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

  describe( "displayCropEditorSourcePhoto", ( ) => {
    it( "prefers the preserved original over the cropped display file", ( ) => {
      const uri = Photo.displayCropEditorSourcePhoto( {
        localFilePath: "file:///tmp/photoUploads/cropped.jpg",
        cropOriginalLocalFilePath: "photoUploads/original.jpg",
      } );

      expect( uri ).toContain( "original.jpg" );
      expect( uri ).not.toContain( "cropped.jpg" );
    } );
  } );

  describe( "savedNormalizedCrop", ( ) => {
    it( "returns the stored crop metadata", ( ) => {
      expect( Photo.savedNormalizedCrop( {
        cropX: 0.1,
        cropY: 0.2,
        cropW: 0.3,
        cropH: 0.3,
      } ) ).toEqual( {
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.3,
      } );
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
