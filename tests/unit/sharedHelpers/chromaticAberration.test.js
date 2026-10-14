import { moveFile } from "@dr.pogodin/react-native-fs";
import * as Exify from "@lodev09/react-native-exify";
import { NativeModules } from "react-native";

// The shared fs mock exports moveFile as a plain function; these tests need to
// see the order the swap happens in, and to make it fail.
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  moveFile: jest.fn( async ( ) => undefined ),
  unlink: jest.fn( async ( ) => undefined ),
  exists: jest.fn( async ( ) => true ),
} ) );

const correctChromaticAberration = jest.fn( );
const applyChromaticAberration = jest.fn( );

// The module reads NativeModules.ImageCropper at import time, so the mock has
// to be in place before it is required.
NativeModules.ImageCropper = { correctChromaticAberration, applyChromaticAberration };
// eslint-disable-next-line global-require
const {
  chromaticAberrationCorrectionAvailable,
  correctPhotoChromaticAberration,
  correctPhotosChromaticAberration,
  forgetLensProfiles,
  lensProfile,
  lensProfileKey,
  localFileUrisForObservations,
} = require( "sharedHelpers/chromaticAberration" );

const LENS = { LensModel: "RF100mm F2.8 L MACRO IS USM", FocalLength: 100 };
// A profile is ten numbers, one per ring from the centre out: the fringing on a
// real lens is not a straight line in radius (see ImageCropper.m).
const RED_RINGS = [0, 0.0001, 0.0002, 0.0004, 0.0005, 0.0005, 0.0004, 0.0003, 0.0002, 0.0002];
const BLUE_RINGS = new Array( 10 ).fill( -0.0001 );

const PHOTO = "file:///photoUploads/IMG_1.jpg";
const PATH = "/photoUploads/IMG_1.jpg";

describe( "correctPhotoChromaticAberration", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    moveFile.mockResolvedValue( undefined );
  } );

  it( "is available when the native module is", ( ) => {
    expect( chromaticAberrationCorrectionAvailable( ) ).toBe( true );
  } );

  it( "swaps the corrected file in, keeping the original until it lands", async ( ) => {
    correctChromaticAberration.mockResolvedValue( { applied: true, redShiftPx: 0.7 } );

    const result = await correctPhotoChromaticAberration( PHOTO );

    expect( result.applied ).toBe( true );
    expect( correctChromaticAberration ).toHaveBeenCalledWith(
      PATH,
      `${PATH}.ca-working.jpg`,
    );
    // Original moved aside first, corrected moved into its place second.
    expect( moveFile.mock.calls ).toEqual( [
      [PATH, `${PATH}.ca-original.jpg`],
      [`${PATH}.ca-working.jpg`, PATH],
    ] );
  } );

  it( "leaves the photo alone when there is nothing to correct", async ( ) => {
    correctChromaticAberration.mockResolvedValue( {
      applied: false,
      reason: "nothing to correct",
    } );

    const result = await correctPhotoChromaticAberration( PHOTO );

    expect( result.applied ).toBe( false );
    expect( moveFile ).not.toHaveBeenCalled( );
  } );

  it( "puts the original back when the swap fails", async ( ) => {
    correctChromaticAberration.mockResolvedValue( { applied: true } );
    moveFile
      .mockResolvedValueOnce( undefined ) // original aside
      .mockRejectedValueOnce( new Error( "no space" ) ) // corrected in
      .mockResolvedValueOnce( undefined ); // original back

    const result = await correctPhotoChromaticAberration( PHOTO );

    expect( result ).toBeNull( );
    expect( moveFile ).toHaveBeenLastCalledWith( `${PATH}.ca-original.jpg`, PATH );
  } );

  it( "never throws when the native call fails", async ( ) => {
    correctChromaticAberration.mockRejectedValue( new Error( "could not load" ) );

    await expect( correctPhotoChromaticAberration( PHOTO ) ).resolves.toBeNull( );
    expect( moveFile ).not.toHaveBeenCalled( );
  } );

  it( "does nothing without a file", async ( ) => {
    await expect( correctPhotoChromaticAberration( undefined ) ).resolves.toBeNull( );
    expect( correctChromaticAberration ).not.toHaveBeenCalled( );
  } );
} );

describe( "correctPhotosChromaticAberration", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    moveFile.mockResolvedValue( undefined );
    forgetLensProfiles( );
    Exify.read.mockResolvedValue( LENS );
  } );

  it( "totals what happened across the batch", async ( ) => {
    correctChromaticAberration
      .mockResolvedValueOnce( { applied: true, redShiftPx: 0.4, blueShiftPx: 0.9 } )
      .mockResolvedValueOnce( { applied: false, reason: "nothing to correct" } )
      .mockRejectedValueOnce( new Error( "could not load" ) );

    const summary = await correctPhotosChromaticAberration( [
      PHOTO,
      "file:///photoUploads/IMG_2.jpg",
      "file:///photoUploads/IMG_3.jpg",
      null,
    ] );

    expect( summary ).toMatchObject( {
      corrected: 1,
      skipped: 1,
      failed: 1,
      maxShiftPx: 0.9,
    } );
  } );

  it( "reports nothing for an empty batch", async ( ) => {
    const summary = await correctPhotosChromaticAberration( [] );
    expect( summary ).toMatchObject( { corrected: 0, skipped: 0, failed: 0 } );
    expect( correctChromaticAberration ).not.toHaveBeenCalled( );
  } );
} );

describe( "localFileUrisForObservations", ( ) => {
  it( "collects every photo file an import just wrote", ( ) => {
    expect( localFileUrisForObservations( [
      {
        observationPhotos: [
          { photo: { localFilePath: "a.jpg" } },
          { photo: { localFilePath: "b.jpg" } },
        ],
      },
      { observationPhotos: [{ photo: { } }] },
      { },
    ] ) ).toEqual( ["a.jpg", "b.jpg"] );
  } );
} );

// The lens a photo was taken with is in its EXIF, and lateral CA is a property
// of that lens: measure it on a couple of frames and the rest of the import
// needs no measuring at all.
describe( "lens profiles", ( ) => {
  const photos = n => Array.from( { length: n }, ( _u, i ) => `file:///photoUploads/IMG_${i}.jpg` );

  beforeEach( ( ) => {
    jest.clearAllMocks( );
    moveFile.mockResolvedValue( undefined );
    forgetLensProfiles( );
    Exify.read.mockResolvedValue( LENS );
    correctChromaticAberration.mockResolvedValue( {
      applied: true,
      measured: true,
      redShiftPx: 0.5,
      redProfile: RED_RINGS,
      blueProfile: BLUE_RINGS,
    } );
    applyChromaticAberration.mockResolvedValue( {
      applied: true, measured: false, redShiftPx: 0.5,
    } );
  } );

  it( "keys a profile on the lens and focal length, not the aperture", ( ) => {
    expect( lensProfileKey( { ...LENS, FNumber: 2.8 } ) )
      .toBe( "RF100mm F2.8 L MACRO IS USM@100mm" );
    expect( lensProfileKey( { ...LENS, FNumber: 16 } ) )
      .toBe( "RF100mm F2.8 L MACRO IS USM@100mm" );
    expect( lensProfileKey( { LensModel: "RF100mm" } ) ).toBeNull( );
    expect( lensProfileKey( null ) ).toBeNull( );
  } );

  // What the photo actually held, ring by ring, so a log line settles what
  // would otherwise be guesswork about the pixels reaching the app.
  it( "reports the shape of the first profile it measured", async ( ) => {
    const summary = await correctPhotosChromaticAberration( photos( 1 ) );

    expect( summary.firstProfile ).toBe(
      "red:0,100,200,400,500,500,400,300,200,200"
      + " blue:-100,-100,-100,-100,-100,-100,-100,-100,-100,-100",
    );
  } );

  it( "reports why a profile was measured but not applied", async ( ) => {
    correctChromaticAberration.mockResolvedValue( {
      applied: false,
      measured: true,
      reason: "no lens-shaped profile",
      redProfile: RED_RINGS,
      blueProfile: BLUE_RINGS,
    } );

    const summary = await correctPhotosChromaticAberration( photos( 1 ) );

    expect( summary.firstProfile ).toContain( "(no lens-shaped profile)" );
  } );

  it( "measures the first frames of a lens, then reuses what it found", async ( ) => {
    const summary = await correctPhotosChromaticAberration( photos( 6 ) );

    // Two measured (MIN_SAMPLES_TO_TRUST), the rest corrected from the profile.
    expect( correctChromaticAberration ).toHaveBeenCalledTimes( 2 );
    expect( applyChromaticAberration ).toHaveBeenCalledTimes( 4 );
    expect( applyChromaticAberration ).toHaveBeenLastCalledWith(
      expect.any( String ),
      expect.any( String ),
      RED_RINGS,
      BLUE_RINGS,
    );
    expect( summary ).toMatchObject( {
      corrected: 6, measured: 2, fromProfile: 4, lenses: 1,
    } );
    expect( lensProfile( "RF100mm F2.8 L MACRO IS USM@100mm" ) ).toMatchObject( {
      red: RED_RINGS, blue: BLUE_RINGS, samples: 2,
    } );
  } );

  it( "remembers a lens that turned out not to need correcting", async ( ) => {
    correctChromaticAberration.mockResolvedValue( {
      applied: false,
      measured: true,
      reason: "nothing to correct",
      redProfile: new Array( 10 ).fill( 0.00001 ),
      blueProfile: new Array( 10 ).fill( 0.00001 ),
    } );
    // The native side declines a profile this small for the same reason it
    // declined the measurement it came from.
    applyChromaticAberration.mockResolvedValue( {
      applied: false,
      measured: false,
      reason: "nothing to correct",
    } );

    const summary = await correctPhotosChromaticAberration( photos( 4 ) );

    expect( summary ).toMatchObject( { corrected: 0, skipped: 4, measured: 2 } );
    expect( lensProfile( "RF100mm F2.8 L MACRO IS USM@100mm" ).samples ).toBe( 2 );
    // The profile is still applied to the rest, and the native side declines it
    // for being too small to see.
    expect( applyChromaticAberration ).toHaveBeenCalledTimes( 2 );
  } );

  it( "averages what it measures rather than trusting one frame", async ( ) => {
    correctChromaticAberration
      .mockResolvedValueOnce( {
        applied: true,
        measured: true,
        redProfile: new Array( 10 ).fill( 0.0002 ),
        blueProfile: new Array( 10 ).fill( 0 ),
      } )
      .mockResolvedValueOnce( {
        applied: true,
        measured: true,
        redProfile: new Array( 10 ).fill( 0.0004 ),
        blueProfile: new Array( 10 ).fill( 0 ),
      } );

    await correctPhotosChromaticAberration( photos( 2 ) );

    // Averaged ring by ring, not taken from whichever frame came last.
    expect( lensProfile( "RF100mm F2.8 L MACRO IS USM@100mm" ).red[5] )
      .toBeCloseTo( 0.0003, 6 );
  } );

  it( "measures every photo when the lens is unknown", async ( ) => {
    Exify.read.mockResolvedValue( { } );

    const summary = await correctPhotosChromaticAberration( photos( 4 ) );

    expect( correctChromaticAberration ).toHaveBeenCalledTimes( 4 );
    expect( applyChromaticAberration ).not.toHaveBeenCalled( );
    expect( summary ).toMatchObject( { lenses: 0, fromProfile: 0 } );
  } );

  it( "keeps a separate profile per focal length of a zoom", async ( ) => {
    Exify.read
      .mockResolvedValueOnce( { LensModel: "RF24-105mm", FocalLength: 24 } )
      .mockResolvedValueOnce( { LensModel: "RF24-105mm", FocalLength: 105 } );

    const summary = await correctPhotosChromaticAberration( photos( 2 ) );

    expect( summary.lenses ).toBe( 2 );
    expect( lensProfile( "RF24-105mm@24mm" ).samples ).toBe( 1 );
    expect( lensProfile( "RF24-105mm@105mm" ).samples ).toBe( 1 );
  } );
} );
