import { gearName, withGearNicknames } from "sharedHelpers/gearNicknames";
import useStore from "stores/useStore";

const nicknames = { camera: { "Canon EOS R5": "Big camera" }, lens: { "RF100mm F2.8": "Macro" } };

describe( "gearNicknames", ( ) => {
  it( "names gear by its nickname, else its own name", ( ) => {
    expect( gearName( nicknames, "camera", "Canon EOS R5" ) ).toBe( "Big camera" );
    expect( gearName( nicknames, "camera", "iPhone 15 Pro" ) ).toBe( "iPhone 15 Pro" );
    expect( gearName( nicknames, "lens", "Canon EOS R5" ) ).toBe( "Canon EOS R5" );
    expect( gearName( nicknames, "lens", undefined ) ).toBeUndefined( );
  } );

  it( "replaces camera and lens names in camera info", ( ) => {
    expect( withGearNicknames( {
      camera: "Canon EOS R5", lens: "RF100mm F2.8", aperture: "f/8",
    }, nicknames ) ).toEqual( { camera: "Big camera", lens: "Macro", aperture: "f/8" } );
    expect( withGearNicknames( null, nicknames ) ).toBeNull( );
  } );

  it( "sets and clears nicknames in the store", ( ) => {
    const { setGearNickname } = useStore.getState( ).layout;
    setGearNickname( "camera", "Canon EOS R5", "  Big camera " );
    expect( useStore.getState( ).layout.gearNicknames.camera )
      .toEqual( { "Canon EOS R5": "Big camera" } );
    // A nickname equal to the name, or empty, removes it
    setGearNickname( "camera", "Canon EOS R5", "Canon EOS R5" );
    expect( useStore.getState( ).layout.gearNicknames.camera ).toEqual( {} );
    setGearNickname( "lens", "RF100mm F2.8", "Macro" );
    setGearNickname( "lens", "RF100mm F2.8", "" );
    expect( useStore.getState( ).layout.gearNicknames.lens ).toEqual( {} );
  } );
} );
