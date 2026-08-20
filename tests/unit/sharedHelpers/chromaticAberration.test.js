import { moveFile } from "@dr.pogodin/react-native-fs";
import { NativeModules } from "react-native";

// The shared fs mock exports moveFile as a plain function; these tests need to
// see the order the swap happens in, and to make it fail.
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  moveFile: jest.fn( async ( ) => undefined ),
  unlink: jest.fn( async ( ) => undefined ),
  exists: jest.fn( async ( ) => true ),
} ) );

const correctChromaticAberration = jest.fn( );

// The module reads NativeModules.ImageCropper at import time, so the mock has
// to be in place before it is required.
NativeModules.ImageCropper = { correctChromaticAberration };
// eslint-disable-next-line global-require
const {
  chromaticAberrationCorrectionAvailable,
  correctPhotoChromaticAberration,
  correctPhotosChromaticAberration,
  localFileUrisForObservations,
} = require( "sharedHelpers/chromaticAberration" );

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
    correctChromaticAberration.mockResolvedValue( { applied: true, redCornerPx: 0.7 } );

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
  } );

  it( "totals what happened across the batch", async ( ) => {
    correctChromaticAberration
      .mockResolvedValueOnce( { applied: true, redCornerPx: 0.4, blueCornerPx: 0.9 } )
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
      maxCornerPx: 0.9,
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
