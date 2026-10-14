import {
  getGalleryAssetDevicePhotoUri,
  getOriginalDevicePhotoUri,
  getOriginalDevicePhotoUrisFromAssets,
  normalizeDevicePhotoUri,
  registerImportedPhotoDeviceUriMappings,
} from "sharedHelpers/getOriginalDevicePhotoUri";

describe( "getOriginalDevicePhotoUri", ( ) => {
  it( "prefers originalPath for photo assets", ( ) => {
    expect( getOriginalDevicePhotoUri( {
      originalPath: "ph://ABC-DEF",
      uri: "file:///tmp/copy.jpg",
      type: "image/jpeg",
    } ) ).toBe( "ph://ABC-DEF" );
  } );

  it( "builds an iOS photo library URI from the asset id", ( ) => {
    expect( getOriginalDevicePhotoUri( {
      id: "ABC-DEF",
      uri: "file:///tmp/copy.jpg",
      type: "image/jpeg",
    } ) ).toBe( "ph://ABC-DEF" );
  } );

  it( "ignores video assets", ( ) => {
    expect( getOriginalDevicePhotoUri( {
      originalPath: "file:///original.mp4",
      uri: "file:///tmp/copy.mp4",
      type: "video/mp4",
    } ) ).toBeNull( );
  } );

  it( "deduplicates URIs extracted from assets", ( ) => {
    expect( getOriginalDevicePhotoUrisFromAssets( [
      {
        originalPath: "ph://ABC-DEF",
        uri: "file:///tmp/one.jpg",
        type: "image/jpeg",
      },
      {
        originalPath: "ph://ABC-DEF",
        uri: "file:///tmp/two.jpg",
        type: "image/jpeg",
      },
    ] ) ).toEqual( ["ph://ABC-DEF"] );
  } );

  it( "does not treat copied file URIs as gallery device URIs", ( ) => {
    expect( getGalleryAssetDevicePhotoUri( {
      uri: "file:///tmp/copy.jpg",
      type: "image/jpeg",
    } ) ).toBeNull( );
  } );

  it( "registers imported local URIs against device URIs", ( ) => {
    const mappings = {};
    registerImportedPhotoDeviceUriMappings(
      mappings,
      "file:///tmp/copy.jpg",
      "ph://ABC-DEF",
    );
    expect( mappings["file:///tmp/copy.jpg"] ).toBe( "ph://ABC-DEF" );
    expect( mappings["/tmp/copy.jpg"] ).toBe( "ph://ABC-DEF" );
  } );

  it( "normalizes bare iOS asset identifiers to photo library URIs", ( ) => {
    expect( normalizeDevicePhotoUri( "ABC-DEF" ) ).toBe( "ph://ABC-DEF" );
    expect( normalizeDevicePhotoUri( "ph://ABC-DEF" ) ).toBe( "ph://ABC-DEF" );
  } );
} );
