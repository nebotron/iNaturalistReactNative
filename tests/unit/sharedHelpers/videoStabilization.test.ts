import type { AnalysisFrame, VideoAnalysis } from "sharedHelpers/videoStabilization";
import {
  applyAffine,
  compose,
  fillGaps,
  homographyToSimilarity,
  invert,
  outputSize,
  paramsToAffine,
  planStabilization,
  strengthToSigmaSeconds,
} from "sharedHelpers/videoStabilization";

const WIDTH = 1000;
const HEIGHT = 600;

const spread = ( values: number[] ) => Math.max( ...values ) - Math.min( ...values );

// A handheld camera: frame i is offset by `offsets[i]` from where it started,
// so a world point at W appears at W − offset in that frame. Registration
// reports the step from each frame onto the previous one.
const shakyBackground = ( offsets: { x: number; y: number }[] ): VideoAnalysis => ( {
  method: "translation",
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
  strength: 1,
  zoom: 1,
  avoidEdges: false,
  outputWidth: WIDTH,
  outputHeight: HEIGHT,
};

describe( "affine helpers", ( ) => {
  it( "inverts a similarity", ( ) => {
    const m = paramsToAffine( {
      tx: 12, ty: -40, rot: 0.3, logScale: 0.2,
    } );
    const p = applyAffine( compose( invert( m ), m ), { x: 123, y: 45 } );
    expect( p.x ).toBeCloseTo( 123 );
    expect( p.y ).toBeCloseTo( 45 );
  } );

  it( "reads a similarity out of a homography", ( ) => {
    const m = paramsToAffine( {
      tx: 5, ty: 7, rot: 0.05, logScale: 0.01,
    } );
    const fitted = homographyToSimilarity( [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1], WIDTH, HEIGHT );
    expect( fitted.a ).toBeCloseTo( m.a );
    expect( fitted.b ).toBeCloseTo( m.b );
    expect( fitted.e ).toBeCloseTo( m.e );
    expect( fitted.f ).toBeCloseTo( m.f );
  } );
} );

describe( "background stabilization", ( ) => {
  const offsets = jitter( 60, 15 );
  const world = { x: 400, y: 300 };
  const outputOfWorldPoint = ( strength: number ) => {
    const plan = planStabilization( shakyBackground( offsets ), { ...baseSettings, strength } );
    return plan.transforms.map( ( m, i ) => applyAffine( m, {
      x: world.x - offsets[i].x,
      y: world.y - offsets[i].y,
    } ) );
  };

  it( "holds the scene still when locked", ( ) => {
    const out = outputOfWorldPoint( 1 );
    expect( spread( out.map( p => p.x ) ) ).toBeLessThan( 1e-6 );
    expect( spread( out.map( p => p.y ) ) ).toBeLessThan( 1e-6 );
  } );

  it( "removes most of the shake when smoothing", ( ) => {
    const raw = spread( offsets.map( o => o.x ) );
    const out = outputOfWorldPoint( 0.3 );
    expect( spread( out.map( p => p.x ) ) ).toBeLessThan( raw / 3 );
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
    const center = applyAffine( plan.transforms[0], { x: 200, y: 150 } );
    expect( center.x ).toBeCloseTo( WIDTH / 2 );
    expect( center.y ).toBeCloseTo( HEIGHT / 2 );
    const xs = plan.firstFrameCrop.map( p => p.x );
    expect( spread( xs ) ).toBeCloseTo( WIDTH / 3 );
  } );

  it( "keeps a steadily rolling shot consistent past 180°", ( ) => {
    const n = 40;
    const step = paramsToAffine( {
      tx: 0, ty: 0, rot: 0.1, logScale: 0,
    } );
    const analysis: VideoAnalysis = {
      method: "similarity",
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      frames: Array.from( { length: n }, ( _v, i ) => ( {
        t: i / 30,
        ok: true,
        m: i === 0
          ? [1, 0, 0, 0, 1, 0, 0, 0, 1]
          : [step.a, step.c, step.e, step.b, step.d, step.f, 0, 0, 1],
      } ) ),
    };
    const plan = planStabilization( analysis, { ...baseSettings, strength: 0.5 } );
    plan.transforms.forEach( m => {
      expect( Number.isFinite( m.a ) ).toBe( true );
      expect( Math.hypot( m.a, m.b ) ).toBeCloseTo( 1 );
    } );
  } );
} );

describe( "subject stabilization", ( ) => {
  const n = 50;
  const subject = ( i: number ) => ( {
    x: 300 + 10 * i + 8 * Math.sin( i ),
    y: 200 + 5 * Math.cos( i * 1.3 ),
    size: 80 + i,
  } );
  const analysis: VideoAnalysis = {
    method: "tracker",
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    frames: Array.from( { length: n }, ( _v, i ) => {
      const s = subject( i );
      return {
        t: i / 30,
        // One lost frame, which should be interpolated over.
        ok: i !== 20,
        conf: 0.9,
        box: [
          ( s.x - s.size / 2 ) / WIDTH,
          ( s.y - s.size / 2 ) / HEIGHT,
          s.size / WIDTH,
          s.size / HEIGHT,
        ],
      };
    } ),
  };

  it( "keeps the subject at the center of the frame", ( ) => {
    const plan = planStabilization( analysis, { ...baseSettings, zoom: 2 } );
    plan.transforms.forEach( ( m, i ) => {
      const p = applyAffine( m, subject( i ) );
      // Within the light de-jitter smoothing applied to tracker boxes.
      expect( Math.abs( p.x - WIDTH / 2 ) ).toBeLessThan( 25 );
      expect( Math.abs( p.y - HEIGHT / 2 ) ).toBeLessThan( 15 );
    } );
  } );

  it( "keeps the subject's size when asked", ( ) => {
    const plan = planStabilization( analysis, { ...baseSettings, lockSize: true } );
    const sizes = plan.transforms.map( ( m, i ) => Math.hypot( m.a, m.b ) * subject( i ).size );
    expect( sizes[n - 1] ).toBeCloseTo( sizes[0], -1 );
    expect( spread( sizes ) ).toBeLessThan( 10 );
  } );
} );

describe( "small helpers", ( ) => {
  it( "fills gaps by interpolation", ( ) => {
    expect( fillGaps( [NaN, 1, NaN, 3, NaN] ) ).toEqual( [1, 1, 2, 3, 3] );
  } );

  it( "keeps the aspect and even dimensions", ( ) => {
    expect( outputSize( 3840, 2160, 1920 ) ).toEqual( { width: 1920, height: 1080 } );
    expect( outputSize( 1080, 1920, 640 ) ).toEqual( { width: 360, height: 640 } );
    expect( outputSize( 641, 361, 2000 ) ).toEqual( { width: 642, height: 362 } );
  } );

  it( "locks fully at the top of the strength slider", ( ) => {
    expect( strengthToSigmaSeconds( 1 ) ).toBe( Infinity );
    expect( strengthToSigmaSeconds( 0 ) ).toBeCloseTo( 0.2 );
  } );
} );
