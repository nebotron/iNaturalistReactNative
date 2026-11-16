// The math behind the video stabilizer (components/VideoStabilizer). The native
// module (ios/.../VideoStabilizer.m) only measures and renders: one pass reads
// the video and reports, per frame, how the camera moved since the last frame
// (and, for a full lock, where the frame sits on the start frame), and a second
// pass warps every frame by the transform this file computes for it. Keeping
// the camera-path math here means changing how smooth or how tight the result
// is never re-reads the video, and the math can be unit tested.
//
// Coordinates: pixels of the upright (display-oriented) source frame, origin
// top-left, y down. Affines are x' = a·x + c·y + e and y' = b·x + d·y + f, the
// same layout as CGAffineTransform. Homographies are row-major 3×3 matrices
// for column vectors (x, y, 1).
//
// The model, for frame i:
//   P_i  the measured path: maps frame i (centered on the frame center) into a
//        stable space, the camera motion accumulated back to the first frame.
//   S_i  the virtual camera's path: P smoothed over time, or the identity when
//        the background is held completely still (a tripod).
//   R_i  the rolling-shutter correction: undoes the lean and squash a moving
//        camera puts into a frame whose rows were read one after another.
// A pixel x of frame i is drawn at  S_i⁻¹ · P_i · (R_i · x − center)  in
// stable space: straightened, placed where the camera was pointing, and viewed
// through the virtual camera. The crop window (center k, zoom z) maps that to
// the output. For a complete lock measured against the first frame, P_i is
// that full homography (perspective included) instead of a similarity.

export type StabilizeMethod = "translation" | "similarity";

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// Row-major 3×3.
export type Homography = number[];

export interface Point {
  x: number;
  y: number;
}

// A similarity transform as the quantities that get smoothed.
export interface PathParams {
  tx: number;
  ty: number;
  rot: number;
  logScale: number;
}

export interface AnalysisFrame {
  // Presentation time in seconds.
  t: number;
  // Whether the measurement for this frame is usable.
  ok: boolean;
  // Homography mapping this frame's pixels onto the previous frame's
  // (identity for the first frame).
  m?: number[];
  // Analyses for a full lock: homography mapping this frame's pixels onto the
  // first frame's, measured against the first frame itself so that errors
  // don't add up over the clip.
  r?: number[];
}

export interface VideoAnalysis {
  method: StabilizeMethod;
  width: number;
  height: number;
  fps: number;
  frames: AnalysisFrame[];
}

export const IDENTITY: Affine = {
  a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
};

const IDENTITY_H: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// first ∘ second: apply `second`, then `first`.
export const compose = ( first: Affine, second: Affine ): Affine => ( {
  a: first.a * second.a + first.c * second.b,
  b: first.b * second.a + first.d * second.b,
  c: first.a * second.c + first.c * second.d,
  d: first.b * second.c + first.d * second.d,
  e: first.a * second.e + first.c * second.f + first.e,
  f: first.b * second.e + first.d * second.f + first.f,
} );

export const invert = ( m: Affine ): Affine => {
  const det = m.a * m.d - m.b * m.c;
  if ( Math.abs( det ) < 1e-12 ) return IDENTITY;
  const a = m.d / det;
  const b = -m.b / det;
  const c = -m.c / det;
  const d = m.a / det;
  return {
    a, b, c, d, e: -( a * m.e + c * m.f ), f: -( b * m.e + d * m.f ),
  };
};

export const applyAffine = ( m: Affine, p: Point ): Point => ( {
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
} );

export const translation = ( x: number, y: number ): Affine => ( { ...IDENTITY, e: x, f: y } );

export const scaling = ( s: number ): Affine => ( { ...IDENTITY, a: s, d: s } );

export const homographyFromAffine = ( m: Affine ): Homography => [
  m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1,
];

// first ∘ second: apply `second`, then `first`.
export const multiplyHomographies = ( first: Homography, second: Homography ): Homography => {
  const r: number[] = [];
  for ( let i = 0; i < 3; i += 1 ) {
    for ( let j = 0; j < 3; j += 1 ) {
      r.push( first[i * 3] * second[j]
        + first[i * 3 + 1] * second[3 + j]
        + first[i * 3 + 2] * second[6 + j] );
    }
  }
  return r;
};

export const invertHomography = ( h: Homography ): Homography => {
  const [a, b, c, d, e, f, g, k, l] = h;
  const det = a * ( e * l - f * k ) - b * ( d * l - f * g ) + c * ( d * k - e * g );
  if ( Math.abs( det ) < 1e-12 ) return [...IDENTITY_H];
  return [
    ( e * l - f * k ) / det, ( c * k - b * l ) / det, ( b * f - c * e ) / det,
    ( f * g - d * l ) / det, ( a * l - c * g ) / det, ( c * d - a * f ) / det,
    ( d * k - e * g ) / det, ( b * g - a * k ) / det, ( a * e - b * d ) / det,
  ];
};

// A point at infinity (or behind the camera) comes back as NaN, which fails
// every comparison, so a crop corner there never counts as inside the frame.
export const applyHomography = ( h: Homography, p: Point ): Point => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if ( !( w > 1e-9 ) ) return { x: NaN, y: NaN };
  return {
    x: ( h[0] * p.x + h[1] * p.y + h[2] ) / w,
    y: ( h[3] * p.x + h[4] * p.y + h[5] ) / w,
  };
};

export const paramsToAffine = ( p: PathParams ): Affine => {
  const s = Math.exp( p.logScale );
  const cos = s * Math.cos( p.rot );
  const sin = s * Math.sin( p.rot );
  return {
    a: cos, b: sin, c: -sin, d: cos, e: p.tx, f: p.ty,
  };
};

// Reads a similarity's parameters; any shear in `m` is ignored.
export const affineToParams = ( m: Affine ): PathParams => ( {
  tx: m.e,
  ty: m.f,
  rot: Math.atan2( m.b - m.c, m.a + m.d ),
  logScale: Math.log( Math.max( 1e-6, Math.hypot( ( m.a + m.d ) / 2, ( m.b - m.c ) / 2 ) ) ),
} );

// Least-squares similarity (rotation, uniform scale, shift) between point sets.
export const fitSimilarity = ( from: Point[], to: Point[] ): Affine => {
  const n = from.length;
  if ( n === 0 ) return IDENTITY;
  const mean = ( points: Point[] ) => points.reduce(
    ( s, p ) => ( { x: s.x + p.x / n, y: s.y + p.y / n } ),
    { x: 0, y: 0 },
  );
  const fromMean = mean( from );
  const toMean = mean( to );
  let dot = 0;
  let cross = 0;
  let norm = 0;
  from.forEach( ( p, i ) => {
    const px = p.x - fromMean.x;
    const py = p.y - fromMean.y;
    const qx = to[i].x - toMean.x;
    const qy = to[i].y - toMean.y;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  } );
  if ( norm < 1e-12 ) return translation( toMean.x - fromMean.x, toMean.y - fromMean.y );
  const a = dot / norm;
  const b = cross / norm;
  return {
    a,
    b,
    c: -b,
    d: a,
    e: toMean.x - ( a * fromMean.x - b * fromMean.y ),
    f: toMean.y - ( b * fromMean.x + a * fromMean.y ),
  };
};

// The similarity closest to a homography over a frame: a perspective term
// from frame-to-frame registration is mostly noise, and smoothing a path
// built from it makes the picture wobble like jelly.
export const homographyToSimilarity = ( h: number[], width: number, height: number ): Affine => {
  const from: Point[] = [];
  const to: Point[] = [];
  for ( let gx = 0; gx <= 4; gx += 1 ) {
    for ( let gy = 0; gy <= 4; gy += 1 ) {
      const p = { x: ( width * gx ) / 4, y: ( height * gy ) / 4 };
      const q = applyHomography( h, p );
      if ( Number.isFinite( q.x ) && Number.isFinite( q.y ) ) {
        from.push( p );
        to.push( q );
      }
    }
  }
  return fitSimilarity( from, to );
};

// Re-expresses a transform about `center` instead of the origin, so rotation
// and zoom in the path turn the picture about its middle.
const aboutCenter = ( m: Affine, center: Point ): Affine => compose(
  translation( -center.x, -center.y ),
  compose( m, translation( center.x, center.y ) ),
);

const unwrapAngles = ( path: PathParams[] ): PathParams[] => {
  let offset = 0;
  return path.map( ( p, i ) => {
    // atan2 jumps by 2π when the camera rolls past ±180°; undo the jump so
    // smoothing doesn't average across it.
    if ( i > 0 ) {
      const delta = p.rot - path[i - 1].rot;
      if ( delta > Math.PI ) offset -= 2 * Math.PI;
      if ( delta < -Math.PI ) offset += 2 * Math.PI;
    }
    return { ...p, rot: p.rot + offset };
  } );
};

// Gaussian smoothing with the ends held, sigma in samples.
export const gaussianSmooth = ( values: number[], sigma: number ): number[] => {
  if ( !( sigma > 0 ) || values.length < 2 ) return [...values];
  const radius = Math.min( Math.ceil( sigma * 3 ), values.length );
  const kernel: number[] = [];
  for ( let k = -radius; k <= radius; k += 1 ) {
    kernel.push( Math.exp( -( k * k ) / ( 2 * sigma * sigma ) ) );
  }
  const last = values.length - 1;
  return values.map( ( _v, i ) => {
    let sum = 0;
    let weight = 0;
    for ( let k = -radius; k <= radius; k += 1 ) {
      const j = Math.min( last, Math.max( 0, i + k ) );
      const w = kernel[k + radius];
      sum += values[j] * w;
      weight += w;
    }
    return sum / weight;
  } );
};

const smoothParams = ( path: PathParams[], sigma: number ): PathParams[] => {
  const pick = ( key: keyof PathParams ) => gaussianSmooth( path.map( p => p[key] ), sigma );
  const tx = pick( "tx" );
  const ty = pick( "ty" );
  const rot = pick( "rot" );
  const logScale = pick( "logScale" );
  return path.map( ( _p, i ) => ( {
    tx: tx[i], ty: ty[i], rot: rot[i], logScale: logScale[i],
  } ) );
};

const usableStep = ( frame: AnalysisFrame, i: number ) => (
  i > 0 && frame.ok && frame.m?.length === 9
);

// Measured path P for every frame, as similarities in centered coordinates.
export const measuredPath = ( analysis: VideoAnalysis ): Affine[] => {
  const { width, height, frames } = analysis;
  const center = { x: width / 2, y: height / 2 };
  const path: Affine[] = [];
  frames.forEach( ( frame, i ) => {
    // A frame whose registration failed is assumed not to have moved.
    const step = usableStep( frame, i )
      ? aboutCenter( homographyToSimilarity( frame.m as number[], width, height ), center )
      : IDENTITY;
    path.push( i === 0
      ? IDENTITY
      : compose( path[i - 1], step ) );
  } );
  return path;
};

// Whether the analysis measured every frame against the first one, which a
// complete lock needs to hold the background without drifting.
export const hasReferencePath = ( analysis: VideoAnalysis ) => analysis.frames.length > 0
  && analysis.frames.every( frame => frame.r?.length === 9 );

// Strength 0–1 from the slider: the virtual camera follows a Gaussian-smoothed
// path, from 0.2 s (keeps the operator's intent, removes only jitter) to 8 s
// (nearly a tripod). Holding the background completely still is a separate
// setting.
export const strengthToSigmaSeconds = ( strength: number ): number => (
  0.2 * 40 ** Math.min( 1, Math.max( 0, strength ) )
);

export const virtualCameraPath = (
  path: Affine[],
  { strength, fps, still = false }: { strength: number; fps: number; still?: boolean },
): Affine[] => {
  if ( still ) return path.map( ( ) => IDENTITY );
  const sigmaSeconds = strengthToSigmaSeconds( strength );
  const params = unwrapAngles( path.map( affineToParams ) );
  return smoothParams( params, sigmaSeconds * Math.max( 1, fps ) ).map( paramsToAffine );
};

// How fast the picture moves across the frame at each frame, in pixels per
// frame, from the registration steps either side of it.
export const contentVelocity = ( analysis: VideoAnalysis ): Point[] => {
  const { width, height, frames } = analysis;
  const center = { x: width / 2, y: height / 2 };
  // Step i: where the content at the center of frame i came from in frame i−1.
  const steps = frames.map( ( frame, i ) => {
    if ( !usableStep( frame, i ) ) return null;
    const before = applyHomography( frame.m as number[], center );
    return Number.isFinite( before.x ) && Number.isFinite( before.y )
      ? { x: center.x - before.x, y: center.y - before.y }
      : null;
  } );
  const raw = frames.map( ( _frame, i ) => {
    const around = [steps[i], steps[i + 1]].filter( Boolean ) as Point[];
    if ( around.length === 0 ) return { x: 0, y: 0 };
    return {
      x: around.reduce( ( sum, p ) => sum + p.x, 0 ) / around.length,
      y: around.reduce( ( sum, p ) => sum + p.y, 0 ) / around.length,
    };
  } );
  // Registration is noisy by a pixel or so; a light smooth keeps that from
  // turning into a wobble of its own.
  const xs = gaussianSmooth( raw.map( v => v.x ), 1 );
  const ys = gaussianSmooth( raw.map( v => v.y ), 1 );
  return raw.map( ( _v, i ) => ( { x: xs[i], y: ys[i] } ) );
};

// A rolling shutter reads the sensor top to bottom, so a row below the middle
// is captured later than the middle row, and a moving picture has moved on by
// then. Sideways motion leans verticals over; up-and-down motion stretches or
// squashes the frame. `readout` is the time the sensor takes to read the frame
// top to bottom, as a fraction of the time between frames. The returned
// affine maps the frame as recorded onto the frame as if every row had been
// read at the moment the middle row was.
export const rollingShutterCorrection = (
  velocity: Point,
  readout: number,
  height: number,
): Affine => {
  // Frames of delay per pixel down the frame.
  const k = readout / height;
  const middle = height / 2;
  return {
    a: 1,
    b: 0,
    c: -velocity.x * k,
    d: 1 - velocity.y * k,
    e: velocity.x * k * middle,
    f: velocity.y * k * middle,
  };
};

export interface StabilizationSettings {
  strength: number;
  // Hold the background exactly where it was in the first frame, including
  // perspective changes when the analysis measured them.
  still?: boolean;
  // Rolling-shutter readout as a fraction of the frame interval; 0 is off.
  rollingShutter?: number;
  // Requested zoom, ≥ 1.
  zoom: number;
  // Zoom in further, if needed, until no frame shows an empty edge.
  avoidEdges: boolean;
  // The source pixel in the first frame the crop should center on.
  cropCenter?: Point;
  outputWidth: number;
  outputHeight: number;
  maxZoom?: number;
}

export interface StabilizationPlan {
  // Per frame: source pixels → output pixels.
  transforms: Homography[];
  // The zoom actually used (≥ the requested one when avoiding edges).
  zoom: number;
  // Whether some frame still shows an empty edge at that zoom.
  edgesVisible: boolean;
  // The output frame's corners in the first source frame, for drawing the
  // crop over a preview of it.
  firstFrameCrop: Point[];
}

export const DEFAULT_MAX_ZOOM = 6;
const EDGE_TOLERANCE_PX = 0.5;

export const planStabilization = (
  analysis: VideoAnalysis,
  settings: StabilizationSettings,
): StabilizationPlan => {
  const { width, height, fps } = analysis;
  const center = { x: width / 2, y: height / 2 };
  const fromCentered = homographyFromAffine( translation( center.x, center.y ) );
  const toCentered = homographyFromAffine( translation( -center.x, -center.y ) );
  const maxZoom = settings.maxZoom ?? DEFAULT_MAX_ZOOM;
  const still = !!settings.still;

  // Stable space → source pixels, per frame.
  let toSource: Homography[];
  if ( still && hasReferencePath( analysis ) ) {
    // The full homography onto the first frame: a flat background, or a
    // distant one, stays exactly put, perspective and all.
    toSource = analysis.frames.map( frame => invertHomography(
      multiplyHomographies( toCentered, frame.r as number[] ),
    ) );
  } else {
    const path = measuredPath( analysis );
    const camera = virtualCameraPath( path, { strength: settings.strength, fps, still } );
    toSource = path.map( ( p, i ) => multiplyHomographies(
      fromCentered,
      homographyFromAffine( compose( invert( p ), camera[i] ) ),
    ) );
  }
  const readout = settings.rollingShutter ?? 0;
  if ( readout > 0 ) {
    const velocity = contentVelocity( analysis );
    toSource = toSource.map( ( m, i ) => multiplyHomographies(
      homographyFromAffine( invert( rollingShutterCorrection( velocity[i], readout, height ) ) ),
      m,
    ) );
  }

  const cropCenter = settings.cropCenter && toSource.length > 0
    ? applyHomography( invertHomography( toSource[0] ), settings.cropCenter )
    : { x: 0, y: 0 };
  const corners = [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ];
  const cropCorners = ( m: Homography, zoom: number ) => corners.map( u => applyHomography( m, {
    x: cropCenter.x + u.x / zoom,
    y: cropCenter.y + u.y / zoom,
  } ) );
  const inside = ( p: Point ) => p.x >= -EDGE_TOLERANCE_PX
    && p.y >= -EDGE_TOLERANCE_PX
    && p.x <= width + EDGE_TOLERANCE_PX
    && p.y <= height + EDGE_TOLERANCE_PX;
  // A convex window lies inside the frame exactly when its corners do, and a
  // homography that keeps every corner in front of the camera keeps it convex.
  const covered = ( zoom: number ) => toSource.every(
    m => cropCorners( m, zoom ).every( inside ),
  );

  let zoom = Math.min( maxZoom, Math.max( 1, settings.zoom ) );
  if ( settings.avoidEdges && !covered( zoom ) ) {
    if ( covered( maxZoom ) ) {
      let low = zoom;
      let high = maxZoom;
      for ( let step = 0; step < 30; step += 1 ) {
        const mid = ( low + high ) / 2;
        if ( covered( mid ) ) {
          high = mid;
        } else {
          low = mid;
        }
      }
      zoom = high;
    } else {
      zoom = maxZoom;
    }
  }

  const outputScale = settings.outputWidth / width;
  const toOutput = homographyFromAffine( compose(
    translation( settings.outputWidth / 2, settings.outputHeight / 2 ),
    compose( scaling( outputScale * zoom ), translation( -cropCenter.x, -cropCenter.y ) ),
  ) );
  return {
    transforms: toSource.map( m => multiplyHomographies( toOutput, invertHomography( m ) ) ),
    zoom,
    edgesVisible: !covered( zoom ),
    firstFrameCrop: toSource.length > 0
      ? cropCorners( toSource[0], zoom )
      : [],
  };
};

// Output dimensions with the source's aspect ratio, the long side capped at
// maxDimension, and both even (H.264 needs even dimensions).
export const outputSize = ( width: number, height: number, maxDimension: number ) => {
  const scale = Math.min( 1, maxDimension / Math.max( width, height ) );
  const even = ( n: number ) => Math.max( 2, Math.round( ( n * scale ) / 2 ) * 2 );
  return { width: even( width ), height: even( height ) };
};

// Nine numbers per frame, scaled so the last is 1.
export const flattenTransforms = ( transforms: Homography[] ): number[] => transforms.flatMap(
  h => ( Math.abs( h[8] ) > 1e-12
    ? h.map( v => v / h[8] )
    : h ),
);
