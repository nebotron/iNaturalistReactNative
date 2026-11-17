// The math behind the video stabilizer (components/VideoStabilizer). The native
// module (ios/.../VideoStabilizer.m) only measures and renders: one pass reads
// the video and reports, per frame, how the picture moved since the last frame
// plus where the frame sits on the start frame, and a second pass warps every frame by
// the transform this file computes for it. Keeping that math here means
// changing the crop or zoom never re-reads the video, and the
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
// A pixel x of frame i is drawn at  L_i · x − center  in stable space,
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
  // Whether `r` was measured against the first frame this frame (rather than
  // carried over from the frame-to-frame steps).
  rok?: boolean;
  // Per tile of the frame (row by row from the top left), the shift [dx, dy]
  // that maps it onto the previous frame (ts) and onto the first frame (tr),
  // or null where the tile couldn't be measured (no texture, or moved out of
  // the frame).
  ts?: ( number[] | null )[];
  tr?: ( number[] | null )[];
}

export interface VideoAnalysis {
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

// The robust fit's settings. Tukey widths are in pixels of a frame 960 px on
// its long side (the size the shifts are measured at) and scale with the
// source. The fit starts wide, so a path far from the readings can still find
// them, and narrows pass by pass until only tiles that agree with the camera
// path to within a few pixels count.
const FIT_READING_WEIGHT = 0.1;
const FIT_START_WIDTH = 48;
const FIT_END_WIDTH = 3;
const FIT_PASSES = 8;
const FIT_REFERENCE_SIZE = 960;

const tukey = ( residual: number, width: number ) => (
  residual < width
    ? ( 1 - ( residual / width ) ** 2 ) ** 2
    : 0
);

const median = ( values: number[] ) => {
  const sorted = [...values].sort( ( p, q ) => p - q );
  const mid = Math.floor( sorted.length / 2 );
  return sorted.length % 2
    ? sorted[mid]
    : ( sorted[mid - 1] + sorted[mid] ) / 2;
};

const tileShifts = ( tiles: ( number[] | null )[] | undefined ): Point[] => ( tiles || [] )
  .filter( ( v ): v is number[] => !!v && v.length === 2
    && Number.isFinite( v[0] ) && Number.isFinite( v[1] ) )
  .map( v => ( { x: v[0], y: v[1] } ) );

// Whether the analysis measured tiles of every frame against the first frame.
export const hasTiles = ( analysis: VideoAnalysis ) => analysis.frames.length > 0
  && analysis.frames.every( frame => Array.isArray( frame.tr ) );

// The camera path, as the shift from each frame onto the first, fitted to
// every tile's measurements at once: each tile's step says how far the
// path moved since the previous frame, and each tile's reading against the
// first frame says where it is, with the readings weighted less so the steps
// carry the frame-to-frame detail and the readings stop the drift. Iteratively
// reweighted least squares with Tukey weights drops the tiles that disagree
// with the path: on the subject, at another depth, or simply mismeasured.
export const fittedTilePath = ( analysis: VideoAnalysis ): Point[] => {
  const { frames } = analysis;
  const n = frames.length;
  if ( n === 0 ) return [];
  const scale = Math.max( analysis.width, analysis.height ) / FIT_REFERENCE_SIZE;
  const center = { x: analysis.width / 2, y: analysis.height / 2 };
  const steps = frames.map( ( frame, i ) => {
    if ( i === 0 ) return [];
    const tiles = tileShifts( frame.ts );
    if ( tiles.length > 0 ) return tiles;
    // No tile could be measured: fall back to the frame's own step.
    if ( usableStep( frame, i ) ) {
      const s = shiftOf( frame.m as number[], center );
      return [{ x: s.e, y: s.f }];
    }
    return [];
  } );
  const readings = frames.map( frame => tileShifts( frame.tr ) );

  // Start from the median steps, chained.
  let path: Point[] = [];
  steps.forEach( ( tiles, i ) => {
    const prev = i === 0
      ? { x: 0, y: 0 }
      : path[i - 1];
    path.push( tiles.length > 0
      ? { x: prev.x + median( tiles.map( p => p.x ) ), y: prev.y + median( tiles.map( p => p.y ) ) }
      : prev );
  } );

  for ( let pass = 0; pass < FIT_PASSES; pass += 1 ) {
    const width = Math.max( FIT_END_WIDTH, FIT_START_WIDTH / 2 ** pass ) * scale;
    const current = path;
    // Normal equations of a chain: tridiagonal, solved in O(n).
    const diag = new Array( n ).fill( 1e-9 );
    const off = new Array( n ).fill( 0 ); // off[i] couples i − 1 and i
    const rhsX = new Array( n ).fill( 0 );
    const rhsY = new Array( n ).fill( 0 );
    for ( let i = 0; i < n; i += 1 ) {
      readings[i].forEach( p => {
        const w = FIT_READING_WEIGHT
          * tukey( Math.hypot( p.x - current[i].x, p.y - current[i].y ), width );
        diag[i] += w;
        rhsX[i] += w * p.x;
        rhsY[i] += w * p.y;
      } );
      if ( i > 0 ) {
        const moved = { x: current[i].x - current[i - 1].x, y: current[i].y - current[i - 1].y };
        steps[i].forEach( p => {
          const w = tukey( Math.hypot( p.x - moved.x, p.y - moved.y ), width );
          diag[i] += w;
          diag[i - 1] += w;
          off[i] -= w;
          rhsX[i] += w * p.x;
          rhsY[i] += w * p.y;
          rhsX[i - 1] -= w * p.x;
          rhsY[i - 1] -= w * p.y;
        } );
      }
    }
    // The first frame is the reference.
    diag[0] += 1e6;
    // Thomas algorithm.
    const c: number[] = new Array( n ).fill( 0 );
    const dx: number[] = new Array( n ).fill( 0 );
    const dy: number[] = new Array( n ).fill( 0 );
    let b = diag[0];
    c[0] = n > 1
      ? off[1] / b
      : 0;
    dx[0] = rhsX[0] / b;
    dy[0] = rhsY[0] / b;
    for ( let i = 1; i < n; i += 1 ) {
      b = diag[i] - off[i] * c[i - 1];
      c[i] = i + 1 < n
        ? off[i + 1] / b
        : 0;
      dx[i] = ( rhsX[i] - off[i] * dx[i - 1] ) / b;
      dy[i] = ( rhsY[i] - off[i] * dy[i - 1] ) / b;
    }
    const next: Point[] = new Array( n );
    next[n - 1] = { x: dx[n - 1], y: dy[n - 1] };
    for ( let i = n - 2; i >= 0; i -= 1 ) {
      next[i] = { x: dx[i] - c[i] * next[i + 1].x, y: dy[i] - c[i] * next[i + 1].y };
    }
    path = next;
  }
  return path;
};

// L for every frame: the shift from the frame onto the first frame.
export const lockPath = ( analysis: VideoAnalysis ): Affine[] => {
  const center = { x: analysis.width / 2, y: analysis.height / 2 };
  if ( hasTiles( analysis ) ) {
    return fittedTilePath( analysis ).map( p => translation( p.x, p.y ) );
  }
  if ( hasReferencePath( analysis ) ) {
    return analysis.frames.map( frame => shiftOf( frame.r as number[], center ) );
  }
  // Without a direct measurement, chain the frame-to-frame steps.
  return measuredPath( analysis );
};

export interface StabilizationSettings {
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
  const toSource: Homography[] = lockPath( analysis ).map(
    lock => multiplyHomographies( homographyFromAffine( invert( lock ) ), fromCentered ),
  );
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
