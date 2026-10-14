import {
  firstDevicePhotoLocation,
  toDevicePhotoLocation,
} from "sharedHelpers/devicePhotoLocation";

describe( "toDevicePhotoLocation", ( ) => {
  it( "should return coordinates from a CameraRoll node location", ( ) => {
    expect( toDevicePhotoLocation( {
      latitude: 38.07,
      longitude: -122.85,
      altitude: 3,
      heading: 0,
      speed: 0,
    } ) ).toEqual( { latitude: 38.07, longitude: -122.85 } );
  } );

  it( "should treat an asset with no location as having none", ( ) => {
    expect( toDevicePhotoLocation( null ) ).toBeNull( );
    expect( toDevicePhotoLocation( undefined ) ).toBeNull( );
    expect( toDevicePhotoLocation( { latitude: 38.07 } ) ).toBeNull( );
  } );

  it( "should reject a zeroed coordinate pair", ( ) => {
    expect( toDevicePhotoLocation( { latitude: 0, longitude: 0 } ) ).toBeNull( );
  } );
} );

describe( "firstDevicePhotoLocation", ( ) => {
  it( "should use the first photo in the group that has a location", ( ) => {
    expect( firstDevicePhotoLocation( [
      { image: { uri: "file:///a.jpg" } },
      { image: { uri: "file:///b.jpg", deviceLocation: { latitude: 1, longitude: 2 } } },
      { image: { uri: "file:///c.jpg", deviceLocation: { latitude: 3, longitude: 4 } } },
    ] ) ).toEqual( { latitude: 1, longitude: 2 } );
  } );

  it( "should return null when no photo has one", ( ) => {
    expect( firstDevicePhotoLocation( [{ image: { uri: "file:///a.jpg" } }] ) ).toBeNull( );
    expect( firstDevicePhotoLocation( [] ) ).toBeNull( );
  } );
} );
