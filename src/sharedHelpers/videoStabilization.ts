// The math behind the video stabilizer (components/VideoStabilizer). The native
// module (ios/.../VideoStabilizer.m) only measures and renders: one pass reads
// the video and reports, per frame, how the picture moved since the last frame
// plus where the frame sits on the start frame, and a second pass warps every frame by
// the transform this file computes for it. Keeping that math here means
// changing the crop, zoom or rolling shutter never re-reads the video, and the
// math can be unit tested.
//
// Coordinates: pixels of the upright (display-oriented) source frame, origin
// top-left, y down. Affines are x' = a·x + c·y + e and y' = b·x + d·y + f, the
// same layout as CGAffineTransform. Homographies are row-major 3×3 matrices
// for column vectors (x, y, 1).
//
// The model, for frame i:
//   L_i  the lock: the shift that maps frame i onto the first frame, lining
//        the background up with the first frame's (a tripod).
//   R_i  the rolling-shutter correction: undoes the lean and squash a moving
//        camera puts into a frame whose rows were read one after another.
// A pixel x of frame i is drawn at  L_i · R_i · x − center  in stable space,
// and the crop window (center k, zoom z) maps that to the output. Only shifts
// are measured and corrected: rotation and zoom are left as they were shot.

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

export interface AnalysisFrame {
  // Presentation time in seconds.
  t: number;
  // Whether the measurement for this frame is usable.
  ok: boolean;
  // Homography mapping this frame's pixels onto the previous frame's
  // (identity for the first frame).
  m?: number[];
  // Transform mapping this frame's pixels onto the first
  // frame's, measured against the first frame itself so that errors don't add
  // up over the clip.
  r?: number[];
  // Analyses for rolling-shutter correction: like `m`, but for the top and
  // bottom strips of the frame registered on their own.
  mt?: number[];
  mb?: number[];
}

export interface VideoAnalysis {
  width: number;
  height: number;
  fps: number;
  frames: AnalysisFrame[];
  // Where the middles of the strips behind `mt` and `mb` sit, in frame heights
  // from the frame's middle (top negative).
  strips?: { top: number; bottom: number };
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

const usableStep = ( frame: AnalysisFrame, i: number ) => (
  i > 0 && frame.ok && frame.m?.length === 9
);

// The shift a registration step makes at the frame's center. Any rotation or
// zoom in the step is ignored.
const shiftOf = ( m: number[], center: Point ): Affine => {
  const moved = applyHomography( m, center );
  return Number.isFinite( moved.x ) && Number.isFinite( moved.y )
    ? translation( moved.x - center.x, moved.y - center.y )
    : IDENTITY;
};

// Measured path P for every frame, as shifts.
export const measuredPath = ( analysis: VideoAnalysis ): Affine[] => {
  const { width, height, frames } = analysis;
  const center = { x: width / 2, y: height / 2 };
  const path: Affine[] = [];
  frames.forEach( ( frame, i ) => {
    // A frame whose registration failed is assumed not to have moved.
    const step = usableStep( frame, i )
      ? shiftOf( frame.m as number[], center )
      : IDENTITY;
    path.push( i === 0
      ? IDENTITY
      : compose( path[i - 1], step ) );
  } );
  return path;
};

// Whether the analysis measured every frame against the first one, which
// holding the background needs to keep it from drifting.
export const hasReferencePath = ( analysis: VideoAnalysis ) => analysis.frames.length > 0
  && analysis.frames.every( frame => frame.r?.length === 9 );

// L for every frame: the shift from the frame onto the first frame.
export const lockPath = ( analysis: VideoAnalysis ): Affine[] => {
  const center = { x: analysis.width / 2, y: analysis.height / 2 };
  if ( hasReferencePath( analysis ) ) {
    return analysis.frames.map( frame => shiftOf( frame.r as number[], center ) );
  }
  // Without a direct measurement, chain the frame-to-frame steps.
  return measuredPath( analysis );
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

export interface ReadoutEstimate {
  // Readout time as a fraction of the frame interval.
  readout: number;
  // Its standard error, likewise.
  error: number;
  // Frames that went into it.
  frames: number;
}

// The fewest frames, and the largest standard error, an estimate is trusted
// with. Below that the camera didn't change speed enough to tell.
const MIN_READOUT_FRAMES = 10;
const MAX_READOUT_ERROR = 0.1;

// Works out the sensor's readout time from how differently the top and bottom
// of the picture moved between frames.
//
// With the picture at X(t), a strip whose rows are read r·s frames after the
// middle row (s its offset from the middle in frame heights) moves by
// X(i + r·s) − X(i − 1 + r·s) between frames i − 1 and i. To first order
// that's the whole frame's step plus r·s·(V(i) − V(i − 1)), where V(i), the
// velocity at frame i, is the mean of the steps either side. So
//
//   bottom step − top step = r · (s_bottom − s_top) · (step(i+1) − step(i−1)) / 2
//
// and r is the least-squares slope over every frame and both axes. Steady
// motion says nothing about it (the strips then move alike, however long the
// readout); only speeding up and slowing down does, which handheld shake
// supplies plenty of. Frames where a moving subject or a bad registration
// throws a strip off are dropped as outliers. Footage the camera already
// corrected (iPhone video stabilization does) measures close to zero.
export const estimateReadout = ( analysis: VideoAnalysis ): ReadoutEstimate | null => {
  const {
    width, height, frames, strips,
  } = analysis;
  if ( !strips ) return null;
  const center = { x: width / 2, y: height / 2 };
  const spread = strips.bottom - strips.top;
  if ( !( spread > 0 ) ) return null;
  const stepAt = ( m: number[] | undefined ): Point | null => {
    if ( m?.length !== 9 ) return null;
    const before = applyHomography( m, center );
    return Number.isFinite( before.x ) && Number.isFinite( before.y )
      ? { x: center.x - before.x, y: center.y - before.y }
      : null;
  };
  const steps = frames.map( ( frame, i ) => ( usableStep( frame, i )
    ? stepAt( frame.m )
    : null ) );

  // Pairs of (predictor, measured difference), one per axis per frame.
  const pairs: [number, number][] = [];
  frames.forEach( ( frame, i ) => {
    const before = steps[i - 1];
    const after = steps[i + 1];
    const top = stepAt( frame.mt );
    const bottom = stepAt( frame.mb );
    if ( !before || !after || !top || !bottom ) return;
    pairs.push( [spread * ( ( after.x - before.x ) / 2 ), bottom.x - top.x] );
    pairs.push( [spread * ( ( after.y - before.y ) / 2 ), bottom.y - top.y] );
  } );

  const fit = ( used: [number, number][] ) => {
    const sxx = used.reduce( ( sum, [a] ) => sum + a * a, 0 );
    const sxy = used.reduce( ( sum, [a, d] ) => sum + a * d, 0 );
    return sxx > 0
      ? sxy / sxx
      : 0;
  };
  const median = ( values: number[] ) => {
    const sorted = [...values].sort( ( p, q ) => p - q );
    const mid = Math.floor( sorted.length / 2 );
    return sorted.length % 2
      ? sorted[mid]
      : ( sorted[mid - 1] + sorted[mid] ) / 2;
  };

  let used = pairs;
  let readout = fit( used );
  // Twice: fit, drop what's far off the line, fit again.
  for ( let pass = 0; pass < 2 && used.length > 0; pass += 1 ) {
    const slope = readout;
    const residuals = pairs.map( ( [a, d] ) => Math.abs( d - slope * a ) );
    // Three standard deviations, from the median (robust to the outliers
    // themselves), but never under half a pixel.
    const limit = Math.max( 3 * 1.4826 * median( residuals ), 0.5 );
    used = pairs.filter( ( [a, d] ) => Math.abs( d - slope * a ) <= limit );
    readout = fit( used );
  }

  const sxx = used.reduce( ( sum, [a] ) => sum + a * a, 0 );
  if ( used.length < 2 * MIN_READOUT_FRAMES || !( sxx > 0 ) ) return null;
  const residual = used.reduce( ( sum, [a, d] ) => sum + ( d - readout * a ) ** 2, 0 );
  const error = Math.sqrt( residual / ( used.length - 1 ) / sxx );
  if ( !( error <= MAX_READOUT_ERROR ) ) return null;
  return {
    // A sensor can't read faster than instantly, nor (in video) slower than
    // a frame.
    readout: Math.min( 1, Math.max( 0, readout ) ),
    error,
    frames: Math.round( used.length / 2 ),
  };
};

export interface StabilizationSettings {
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
  const { width, height } = analysis;
  const center = { x: width / 2, y: height / 2 };
  const fromCentered = homographyFromAffine( translation( center.x, center.y ) );
  const maxZoom = settings.maxZoom ?? DEFAULT_MAX_ZOOM;

  // Stable space → source pixels, per frame.
  let toSource: Homography[] = lockPath( analysis ).map(
    lock => multiplyHomographies( homographyFromAffine( invert( lock ) ), fromCentered ),
  );
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
