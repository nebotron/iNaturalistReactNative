import {
  cropOriginalUriFromPath,
  normalizedCropToStorage,
  savedNormalizedCrop,
} from "sharedHelpers/cropPhotoMetadata";

describe( "cropPhotoMetadata", ( ) => {
  describe( "savedNormalizedCrop", ( ) => {
    it( "returns null when crop metadata is incomplete", ( ) => {
      expect( savedNormalizedCrop( { cropX: 0.1 } ) ).toBeNull( );
    } );

    it( "returns a normalized crop when all fields are present", ( ) => {
      expect( savedNormalizedCrop( {
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

  describe( "normalizedCropToStorage", ( ) => {
    it( "maps a normalized crop to storage fields", ( ) => {
      expect( normalizedCropToStorage( {
        x: 0.4,
        y: 0.5,
        w: 0.2,
        h: 0.2,
      } ) ).toEqual( {
        cropX: 0.4,
        cropY: 0.5,
        cropW: 0.2,
        cropH: 0.2,
      } );
    } );
  } );

  describe( "cropOriginalUriFromPath", ( ) => {
    it( "builds a file uri from a photoUploads path", ( ) => {
      const uri = cropOriginalUriFromPath( "photoUploads/original.jpg" );
      expect( uri ).toMatch( /^file:\/\// );
      expect( uri ).toContain( "original.jpg" );
    } );
  } );
} );
