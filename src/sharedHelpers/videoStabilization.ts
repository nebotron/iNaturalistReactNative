// The math behind the video stabilizer (components/VideoStabilizer). The native
// module (ios/.../VideoStabilizer.m) only measures and renders: one pass reads
// the video and reports, per frame, either how the camera moved since the last
// frame (background methods) or where the subject is (subject methods), and a
// second pass warps every frame by the transform this file computes for it.
// Keeping the camera-path math here means changing how smooth or how tight the
// result is never re-reads the video, and the math can be unit tested.
//
// Coordinates: pixels of the upright (display-oriented) source frame, origin
// top-left, y down. Transforms are 2D affines, x' = a·x + c·y + e and
// y' = b·x + d·y + f, the same layout as CGAffineTransform.
//
// The model, for frame i:
//   P_i  the measured path: maps frame i (centered on the frame center) into a
//        stable space. For the background it's the accumulated camera motion
//        back to the first frame; for a subject it moves the subject to the
//        origin (and optionally rescales it to its first-frame size).
//   S_i  the virtual camera's path: P smoothed over time, or the identity when
//        locked (a tripod for the background, a hard lock on the subject).
// A pixel x of frame i is drawn at  S_i⁻¹ · P_i · (x − center)  in stable
// space, and the crop window (center k, zoom z) maps that to the output.

export type StabilizeMethod = "translation" | "similarity" | "tracker" | "saliency";

export const isSubjectMethod = ( method: StabilizeMethod ) => (
  method === "tracker" || method === "saliency"
);

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

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
  // Background methods: row-major 3×3 homography mapping this frame's pixels
  // onto the previous frame's (identity for the first frame).
  m?: number[];
  // Subject methods: [x, y, width, height], normalized 0–1, origin top-left.
  box?: number[];
  // Subject methods: the tracker's or detector's confidence, 0–1.
  conf?: number;
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

const applyHomography = ( h: number[], p: Point ): Point | null => {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if ( Math.abs( w ) < 1e-9 ) return null;
  return {
    x: ( h[0] * p.x + h[1] * p.y + h[2] ) / w,
    y: ( h[3] * p.x + h[4] * p.y + h[5] ) / w,
  };
};

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
// from frame-to-frame registration is mostly noise, and warping by it makes
// the picture wobble like jelly.
export const homographyToSimilarity = ( h: number[], width: number, height: number ): Affine => {
  const from: Point[] = [];
  const to: Point[] = [];
  for ( let gx = 0; gx <= 4; gx += 1 ) {
    for ( let gy = 0; gy <= 4; gy += 1 ) {
      const p = { x: ( width * gx ) / 4, y: ( height * gy ) / 4 };
      const q = applyHomography( h, p );
      if ( q ) {
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

// Fills gaps (NaN) by linear interpolation, holding the nearest value at ends.
export const fillGaps = ( values: number[] ): number[] => {
  const known = values
    .map( ( v, i ) => ( Number.isFinite( v )
      ? i
      : -1 ) )
    .filter( i => i >= 0 );
  if ( known.length === 0 ) return values.map( ( ) => 0 );
  return values.map( ( v, i ) => {
    if ( Number.isFinite( v ) ) return v;
    const next = known.find( k => k > i );
    const prev = [...known].reverse( ).find( k => k < i );
    if ( prev === undefined ) return values[next as number];
    if ( next === undefined ) return values[prev];
    const t = ( i - prev ) / ( next - prev );
    return values[prev] + t * ( values[next] - values[prev] );
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

// Below this a tracker's box is treated as lost and its position interpolated.
const MIN_SUBJECT_CONFIDENCE = 0.3;
// How far "keep subject size" may rescale a frame, either way.
const MAX_SIZE_CORRECTION = 2;

// Measured path P for every frame, as similarities in centered coordinates.
export const measuredPath = (
  analysis: VideoAnalysis,
  { lockSize = false }: { lockSize?: boolean } = {},
): Affine[] => {
  const { width, height, frames } = analysis;
  const center = { x: width / 2, y: height / 2 };
  if ( !isSubjectMethod( analysis.method ) ) {
    const path: Affine[] = [];
    frames.forEach( ( frame, i ) => {
      // A frame whose registration failed is assumed not to have moved.
      const step = i > 0 && frame.ok && frame.m?.length === 9
        ? aboutCenter( homographyToSimilarity( frame.m, width, height ), center )
        : IDENTITY;
      path.push( i === 0
        ? IDENTITY
        : compose( path[i - 1], step ) );
    } );
    return path;
  }

  const usable = ( frame: AnalysisFrame ) => frame.ok
    && frame.box?.length === 4
    && ( frame.conf ?? 1 ) >= MIN_SUBJECT_CONFIDENCE;
  const column = ( pick: ( box: number[] ) => number ) => fillGaps( frames.map( frame => (
    usable( frame )
      ? pick( frame.box as number[] )
      : NaN
  ) ) );
  // Trackers' boxes jitter by a pixel or two every frame; a light smooth
  // keeps a hard lock from passing that on as shake.
  const cx = gaussianSmooth( column( box => ( box[0] + box[2] / 2 ) * width ), 1.5 );
  const cy = gaussianSmooth( column( box => ( box[1] + box[3] / 2 ) * height ), 1.5 );
  // Box sizes are noisier than positions, so the size is smoothed harder.
  const size = gaussianSmooth( column( box => Math.log(
    Math.max( 1e-4, Math.sqrt( box[2] * width * box[3] * height ) ),
  ) ), 4 );
  return frames.map( ( _frame, i ) => {
    const s = lockSize
      ? Math.min( MAX_SIZE_CORRECTION, Math.max(
        1 / MAX_SIZE_CORRECTION,
        Math.exp( size[0] - size[i] ),
      ) )
      : 1;
    // x ↦ s · (x − subject offset): the subject lands on the origin.
    return compose( scaling( s ), translation( -( cx[i] - center.x ), -( cy[i] - center.y ) ) );
  } );
};

// Strength 0–1 from the slider. 1 locks the shot completely; below that the
// virtual camera follows a Gaussian-smoothed path, from 0.2 s (keeps the
// operator's intent, removes only jitter) to 8 s (nearly locked).
export const strengthToSigmaSeconds = ( strength: number ): number => (
  strength >= 1
    ? Infinity
    : 0.2 * 40 ** Math.max( 0, strength )
);

export const virtualCameraPath = (
  path: Affine[],
  { strength, fps }: { strength: number; fps: number },
): Affine[] => {
  const sigmaSeconds = strengthToSigmaSeconds( strength );
  if ( !Number.isFinite( sigmaSeconds ) ) return path.map( ( ) => IDENTITY );
  const params = unwrapAngles( path.map( affineToParams ) );
  return smoothParams( params, sigmaSeconds * Math.max( 1, fps ) ).map( paramsToAffine );
};

export interface StabilizationSettings {
  strength: number;
  // Rescale every frame so the subject keeps its first-frame size.
  lockSize?: boolean;
  // Requested zoom, ≥ 1.
  zoom: number;
  // Zoom in further, if needed, until no frame shows an empty edge.
  avoidEdges: boolean;
  // Background methods: the source pixel in the first frame the crop should
  // center on. Subject methods always center on the subject.
  cropCenter?: Point;
  outputWidth: number;
  outputHeight: number;
  maxZoom?: number;
}

export interface StabilizationPlan {
  // Per frame: source pixels → output pixels.
  transforms: Affine[];
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
  const maxZoom = settings.maxZoom ?? DEFAULT_MAX_ZOOM;
  const path = measuredPath( analysis, { lockSize: settings.lockSize } );
  const camera = virtualCameraPath( path, { strength: settings.strength, fps } );
  // Stable space → source pixels, per frame.
  const toSource = path.map( ( p, i ) => compose(
    translation( center.x, center.y ),
    compose( invert( p ), camera[i] ),
  ) );
  const cropCenter = !isSubjectMethod( analysis.method ) && settings.cropCenter && path.length > 0
    ? applyAffine(
      compose( invert( camera[0] ), path[0] ),
      { x: settings.cropCenter.x - center.x, y: settings.cropCenter.y - center.y },
    )
    : { x: 0, y: 0 };
  const corners = [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ];
  const cropCorners = ( m: Affine, zoom: number ) => corners.map( u => applyAffine( m, {
    x: cropCenter.x + u.x / zoom,
    y: cropCenter.y + u.y / zoom,
  } ) );
  const inside = ( p: Point ) => p.x >= -EDGE_TOLERANCE_PX
    && p.y >= -EDGE_TOLERANCE_PX
    && p.x <= width + EDGE_TOLERANCE_PX
    && p.y <= height + EDGE_TOLERANCE_PX;
  // A convex window lies inside the frame exactly when its corners do.
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
  const toOutput = compose(
    translation( settings.outputWidth / 2, settings.outputHeight / 2 ),
    compose( scaling( outputScale * zoom ), translation( -cropCenter.x, -cropCenter.y ) ),
  );
  return {
    transforms: toSource.map( m => compose( toOutput, invert( m ) ) ),
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

export const flattenTransforms = ( transforms: Affine[] ): number[] => transforms.flatMap(
  m => [m.a, m.b, m.c, m.d, m.e, m.f],
);
