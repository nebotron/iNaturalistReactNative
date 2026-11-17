import type {
  AnalysisFrame,
  Homography,
  Point,
  VideoAnalysis,
} from "sharedHelpers/videoStabilization";
import {
  applyAffine,
  applyHomography,
  compose,
  flattenTransforms,
  invert,
  invertHomography,
  outputSize,
  planStabilization,
  subjectPath,
} from "sharedHelpers/videoStabilization";

const WIDTH = 1000;
const HEIGHT = 600;

const spread = ( values: number[] ) => Math.max( ...values ) - Math.min( ...values );

// A handheld camera: frame i is offset by `offsets[i]` from where it started,
// so a world point at W appears at W − offset in that frame. Registration
// reports the step from each frame onto the previous one.
const shakyBackground = ( offsets: { x: number; y: number }[] ): VideoAnalysis => ( {
  width: WIDTH,
  height: HEIGHT,
  fps: 30,
  frames: offsets.map( ( o, i ): AnalysisFrame => {
    const prev = offsets[Math.max( 0, i - 1 )];
    return {
      t: i / 30,
      ok: true,
      m: [1, 0, o.x - prev.x, 0, 1, o.y - prev.y, 0, 0, 1],
    };
  } ),
} );

const jitter = ( n: number, amplitude: number ) => Array.from( { length: n }, ( _v, i ) => ( {
  x: amplitude * Math.sin( i * 1.7 ),
  y: amplitude * Math.cos( i * 2.3 ),
} ) );

const baseSettings = {
  mode: "background" as const,
  zoom: 1,
  avoidEdges: false,
  outputWidth: WIDTH,
  outputHeight: HEIGHT,
};

describe( "affine helpers", ( ) => {
  it( "inverts an affine", ( ) => {
    const m = {
      a: 1.1, b: 0.2, c: -0.3, d: 0.9, e: 12, f: -40,
    };
    const p = applyAffine( compose( invert( m ), m ), { x: 123, y: 45 } );
    expect( p.x ).toBeCloseTo( 123 );
    expect( p.y ).toBeCloseTo( 45 );
  } );
} );

describe( "background stabilization", ( ) => {
  const offsets = jitter( 60, 15 );
  const world = { x: 400, y: 300 };
  const outputOfWorldPoint = ( ) => {
    const plan = planStabilization( shakyBackground( offsets ), baseSettings );
    return plan.transforms.map( ( m, i ) => applyHomography( m, {
      x: world.x - offsets[i].x,
      y: world.y - offsets[i].y,
    } ) );
  };

  it( "holds the scene still", ( ) => {
    const out = outputOfWorldPoint( );
    expect( spread( out.map( p => p.x ) ) ).toBeLessThan( 1e-6 );
    expect( spread( out.map( p => p.y ) ) ).toBeLessThan( 1e-6 );
  } );

  it( "zooms in just enough to hide the empty edges", ( ) => {
    const analysis = shakyBackground( offsets );
    expect( planStabilization( analysis, baseSettings ).edgesVisible ).toBe( true );
    const plan = planStabilization( analysis, { ...baseSettings, avoidEdges: true } );
    expect( plan.edgesVisible ).toBe( false );
    // A lock holds the first frame's framing, so the margin each side needs
    // is the furthest the camera strayed from where it started.
    const needed = ( axis: "x" | "y", half: number ) => half / ( half - Math.max(
      ...offsets.map( o => Math.abs( o[axis] - offsets[0][axis] ) ),
    ) );
    expect( plan.zoom ).toBeCloseTo(
      Math.max( needed( "x", WIDTH / 2 ), needed( "y", HEIGHT / 2 ) ),
      // Within the planner's half-pixel edge tolerance.
      2,
    );
  } );

  it( "centers the crop on the chosen point", ( ) => {
    const plan = planStabilization( shakyBackground( offsets ), {
      ...baseSettings,
      zoom: 3,
      cropCenter: { x: 200, y: 150 },
    } );
    const center = applyHomography( plan.transforms[0], { x: 200, y: 150 } );
    expect( center.x ).toBeCloseTo( WIDTH / 2 );
    expect( center.y ).toBeCloseTo( HEIGHT / 2 );
    const xs = plan.firstFrameCrop.map( p => p.x );
    expect( spread( xs ) ).toBeCloseTo( WIDTH / 3 );
  } );

  it( "leaves rotation and zoom alone", ( ) => {
    // Every step rotates and zooms about the frame center without shifting it.
    const cos = 1.01 * Math.cos( 0.05 );
    const sin = 1.01 * Math.sin( 0.05 );
    const cx = WIDTH / 2;
    const cy = HEIGHT / 2;
    const step = [
      cos, -sin, cx - cos * cx + sin * cy,
      sin, cos, cy - sin * cx - cos * cy,
      0, 0, 1,
    ];
    const analysis: VideoAnalysis = {
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      frames: Array.from( { length: 20 }, ( _v, i ) => ( {
        t: i / 30,
        ok: true,
        m: i === 0
          ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
          : step,
      } ) ),
    };
    const plan = planStabilization( analysis, baseSettings );
    plan.transforms.forEach( m => {
      expect( m ).toEqual( plan.transforms[0] );
    } );
  } );
} );

describe( "holding the background against the first frame", ( ) => {
  // The chained frame-to-frame steps drift; the shifts measured against the
  // first frame don't.
  const n = 30;
  const offset = ( i: number ) => ( { x: 3 * Math.sin( i ) * i, y: 2 * Math.cos( i ) - 2 } );
  const toFirst = ( i: number ): Homography => [
    1, 0, offset( i ).x, 0, 1, offset( i ).y, 0, 0, 1,
  ];
  const analysis: VideoAnalysis = {
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    frames: Array.from( { length: n }, ( _v, i ) => ( {
      t: i / 30,
      ok: true,
      m: [1, 0, 0.5, 0, 1, -0.5, 0, 0, 1],
      r: toFirst( i ),
    } ) ),
  };

  it( "pins every background point to the first frame", ( ) => {
    const plan = planStabilization( analysis, { ...baseSettings, zoom: 1.5 } );
    [{ x: 100, y: 80 }, { x: 900, y: 520 }, { x: 500, y: 300 }].forEach( point => {
      const out = plan.transforms.map( ( m, i ) => applyHomography(
        m,
        applyHomography( invertHomography( toFirst( i ) ), point ),
      ) );
      expect( spread( out.map( p => p.x ) ) ).toBeLessThan( 1e-6 );
      expect( spread( out.map( p => p.y ) ) ).toBeLessThan( 1e-6 );
    } );
  } );
} );

describe( "subject stabilization", ( ) => {
  // The camera shakes while the subject walks steadily right, 10 px a frame.
  const n = 40;
  const offsets = jitter( n, 15 );
  const subjectInWorld = ( i: number ) => ( { x: 300 + 10 * i, y: 250 } );
  const subjectInFrame = ( i: number ) => ( {
    x: subjectInWorld( i ).x - offsets[i].x,
    y: subjectInWorld( i ).y - offsets[i].y,
  } );
  const analysis = ( lost: number[] = [] ): VideoAnalysis => {
    const background = shakyBackground( offsets );
    return {
      ...background,
      frames: background.frames.map( ( frame, i ) => ( {
        ...frame,
        s: lost.includes( i )
          ? null
          : [subjectInFrame( i ).x, subjectInFrame( i ).y],
      } ) ),
    };
  };

  it( "keeps the subject where it was in the first frame", ( ) => {
    const plan = planStabilization( analysis( ), { ...baseSettings, mode: "subject" } );
    const out = plan.transforms.map( ( m, i ) => applyHomography( m, subjectInFrame( i ) ) );
    expect( spread( out.map( p => p.x ) ) ).toBeLessThan( 1e-6 );
    expect( spread( out.map( p => p.y ) ) ).toBeLessThan( 1e-6 );
  } );

  it( "lets the background move past the subject", ( ) => {
    const plan = planStabilization( analysis( ), { ...baseSettings, mode: "subject" } );
    const world = { x: 500, y: 300 };
    const out = plan.transforms.map( ( m, i ) => applyHomography( m, {
      x: world.x - offsets[i].x,
      y: world.y - offsets[i].y,
    } ) );
    expect( out[0].x - out[n - 1].x ).toBeGreaterThan( 10 * ( n - 2 ) );
  } );

  it( "fills in frames where the tracker lost the subject", ( ) => {
    const path = subjectPath( analysis( [0, 10, 11, n - 1] ) ) as Point[];
    expect( path ).toHaveLength( n );
    path.forEach( p => {
      expect( Number.isFinite( p.x ) && Number.isFinite( p.y ) ).toBe( true );
    } );
    // On the line from frame 9 to frame 12, and held at the ends.
    expect( path[10].x ).toBeCloseTo( path[9].x + ( path[12].x - path[9].x ) / 3 );
    expect( path[0] ).toEqual( path[1] );
    expect( path[n - 1] ).toEqual( path[n - 2] );
  } );

  it( "falls back to the background when the subject was never found", ( ) => {
    const lostEverywhere = analysis( Array.from( { length: n }, ( _v, i ) => i ) );
    expect( subjectPath( lostEverywhere ) ).toBeNull( );
    expect( planStabilization( lostEverywhere, { ...baseSettings, mode: "subject" } ).transforms )
      .toEqual( planStabilization( lostEverywhere, baseSettings ).transforms );
  } );
} );

describe( "small helpers", ( ) => {
  it( "keeps the aspect and even dimensions", ( ) => {
    expect( outputSize( 3840, 2160, 1920 ) ).toEqual( { width: 1920, height: 1080 } );
    expect( outputSize( 1080, 1920, 640 ) ).toEqual( { width: 360, height: 640 } );
    expect( outputSize( 641, 361, 2000 ) ).toEqual( { width: 642, height: 362 } );
  } );

  it( "flattens homographies to nine numbers ending in 1", ( ) => {
    expect( flattenTransforms( [[2, 0, 4, 0, 2, 6, 0, 0, 2]] ) )
      .toEqual( [1, 0, 2, 0, 1, 3, 0, 0, 1] );
  } );
} );
