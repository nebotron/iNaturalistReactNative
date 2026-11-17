import type {
  AnalysisFrame,
  Point,
  VideoAnalysis,
} from "sharedHelpers/videoStabilization";
import {
  applyAffine,
  applyHomography,
  compose,
  fittedTilePath,
  flattenTransforms,
  invert,
  outputSize,
  planStabilization,
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
  // The camera's offset in frame i; a world point W appears at W − offset.
  const n = 40;
  const offset = ( i: number ) => ( { x: 3 * Math.sin( i ) * i, y: 2 * Math.cos( i ) - 2 } );
  const TILES = 16;
  // Each tile's step onto the previous frame and reading onto the first, as
  // the native analysis reports them; `tile` can distort any of them.
  const tiledAnalysis = (
    tile: ( k: number, i: number, step: Point, reading: Point ) => {
      step: Point | null;
      reading: Point | null;
    } = ( _k, _i, step, reading ) => ( { step, reading } ),
  ): VideoAnalysis => ( {
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    frames: Array.from( { length: n }, ( _v, i ) => {
      const o = offset( i );
      const prev = offset( Math.max( 0, i - 1 ) );
      const measured = Array.from( { length: TILES }, ( _t, k ) => tile(
        k,
        i,
        { x: o.x - prev.x, y: o.y - prev.y },
        o,
      ) );
      return {
        t: i / 30,
        ok: true,
        m: [1, 0, o.x - prev.x, 0, 1, o.y - prev.y, 0, 0, 1],
        r: [1, 0, o.x, 0, 1, o.y, 0, 0, 1],
        rok: true,
        ts: measured.map( ( { step } ) => ( i > 0 && step
          ? [step.x, step.y]
          : null ) ),
        tr: measured.map( ( { reading } ) => ( reading
          ? [reading.x, reading.y]
          : null ) ),
      };
    } ),
  } );
  const worstError = ( analysis: VideoAnalysis ) => Math.max( ...fittedTilePath( analysis ).map(
    ( p, i ) => Math.hypot( p.x - offset( i ).x, p.y - offset( i ).y ),
  ) );

  it( "pins every background point to the first frame", ( ) => {
    const plan = planStabilization( tiledAnalysis( ), { ...baseSettings, zoom: 1.5 } );
    [{ x: 100, y: 80 }, { x: 900, y: 520 }, { x: 500, y: 300 }].forEach( point => {
      const out = plan.transforms.map( ( m, i ) => applyHomography( m, {
        x: point.x - offset( i ).x,
        y: point.y - offset( i ).y,
      } ) );
      expect( spread( out.map( p => p.x ) ) ).toBeLessThan( 1e-3 );
      expect( spread( out.map( p => p.y ) ) ).toBeLessThan( 1e-3 );
    } );
  } );

  it( "ignores tiles that follow a moving subject", ( ) => {
    // Five tiles sit on an animal walking 4 px a frame across the scene.
    const walking = tiledAnalysis( ( k, i, step, reading ) => ( k < 5
      ? {
        step: { x: step.x + 4, y: step.y },
        reading: { x: reading.x + 4 * i, y: reading.y },
      }
      : { step, reading } ) );
    expect( worstError( walking ) ).toBeLessThan( 0.01 );
  } );

  it( "ignores readings that jump to the wrong match", ( ) => {
    // Every few frames, half the readings latch onto something 60 px away.
    const jumpy = tiledAnalysis( ( k, i, step, reading ) => ( i % 4 === 3 && k % 2 === 0
      ? { step, reading: { x: reading.x + 60, y: reading.y - 20 } }
      : { step, reading } ) );
    expect( worstError( jumpy ) ).toBeLessThan( 0.01 );
  } );

  it( "stops frame-to-frame steps from drifting", ( ) => {
    // Every step is a little long, which would add up to 12 px by the end.
    const biased = tiledAnalysis( ( _k, _i, step, reading ) => ( {
      step: { x: step.x + 0.3, y: step.y },
      reading,
    } ) );
    expect( worstError( biased ) ).toBeLessThan( 1 );
  } );

  it( "keeps going through frames with no tile measured", ( ) => {
    const gappy = tiledAnalysis( ( _k, i, step, reading ) => ( i >= 10 && i < 14
      ? { step: null, reading: null }
      : { step, reading } ) );
    expect( worstError( gappy ) ).toBeLessThan( 0.01 );
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
