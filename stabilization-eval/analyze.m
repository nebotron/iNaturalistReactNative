// Runs the Video Stabilizer's background analysis outside the app, on macOS,
// so it can be measured against other approaches on the same clips.
//
// Everything between the COPIED markers is pasted verbatim from
// ios/iNaturalistReactNative/VideoStabilizer.m (at the commit this ran on); the base
// pass below follows analyze() line for line for background mode with the
// rolling-shutter strips off. A second set of measurements (tiles at 960 px,
// and Vision's homographic registration) rides along on the same frames for
// the alternatives being evaluated; it doesn't touch the base pass's state.
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>
#import <Vision/Vision.h>

// ---- COPIED ----
static const double kMaxFrameRate = 60;
typedef struct { double m[9]; } Mat3;  // row-major

static Mat3 mat3Identity( void )
{
  Mat3 r = { { 1, 0, 0, 0, 1, 0, 0, 0, 1 } };
  return r;
}

static Mat3 mat3Mul( Mat3 a, Mat3 b )
{
  Mat3 r;
  for ( int i = 0; i < 3; i++ ) {
    for ( int j = 0; j < 3; j++ ) {
      r.m[i * 3 + j] = a.m[i * 3] * b.m[j] + a.m[i * 3 + 1] * b.m[3 + j] + a.m[i * 3 + 2] * b.m[6 + j];
    }
  }
  return r;
}

static Mat3 mat3Inv( Mat3 a )
{
  const double *m = a.m;
  double det = m[0] * ( m[4] * m[8] - m[5] * m[7] )
    - m[1] * ( m[3] * m[8] - m[5] * m[6] )
    + m[2] * ( m[3] * m[7] - m[4] * m[6] );
  if ( fabs( det ) < 1e-12 ) return mat3Identity( );
  Mat3 r = { {
    ( m[4] * m[8] - m[5] * m[7] ) / det, ( m[2] * m[7] - m[1] * m[8] ) / det, ( m[1] * m[5] - m[2] * m[4] ) / det,
    ( m[5] * m[6] - m[3] * m[8] ) / det, ( m[0] * m[8] - m[2] * m[6] ) / det, ( m[2] * m[3] - m[0] * m[5] ) / det,
    ( m[3] * m[7] - m[4] * m[6] ) / det, ( m[1] * m[6] - m[0] * m[7] ) / det, ( m[0] * m[4] - m[1] * m[3] ) / det,
  } };
  return r;
}

// y ↦ height − y, its own inverse: converts between top-left and bottom-left.
static Mat3 mat3FlipY( double height )
{
  Mat3 r = { { 1, 0, 0, 0, -1, height, 0, 0, 1 } };
  return r;
}

static Mat3 mat3Scale( double s )
{
  Mat3 r = { { s, 0, 0, 0, s, 0, 0, 0, 1 } };
  return r;
}

static CGAffineTransform mat3AffinePart( Mat3 h )
{
  double w = fabs( h.m[8] ) > 1e-9 ? h.m[8] : 1;
  return CGAffineTransformMake( h.m[0] / w, h.m[3] / w, h.m[1] / w, h.m[4] / w, h.m[2] / w, h.m[5] / w );
}

static Mat3 mat3FromAffine( CGAffineTransform a )
{
  Mat3 r = { { a.a, a.c, a.tx, a.b, a.d, a.ty, 0, 0, 1 } };
  return r;
}

// Warps `image` by `h`, a homography between bottom-left pixel spaces. Core
// Image's perspective filter maps the image's corners to four points, which
// is exactly a homography; a plain affine takes the cheaper path.
static CIImage *warpImage( CIImage *image, Mat3 h )
{
  double w = fabs( h.m[8] ) > 1e-9 ? h.m[8] : 1;
  if ( fabs( h.m[6] / w ) < 1e-12 && fabs( h.m[7] / w ) < 1e-12 ) {
    return [image imageByApplyingTransform:mat3AffinePart( h )];
  }
  CGRect e = image.extent;
  double xs[4] = { CGRectGetMinX( e ), CGRectGetMaxX( e ), CGRectGetMaxX( e ), CGRectGetMinX( e ) };
  double ys[4] = { CGRectGetMaxY( e ), CGRectGetMaxY( e ), CGRectGetMinY( e ), CGRectGetMinY( e ) };
  CIVector *corners[4];
  for ( int i = 0; i < 4; i++ ) {
    double pw = h.m[6] * xs[i] + h.m[7] * ys[i] + h.m[8];
    // A corner at or behind the horizon can't be drawn; settle for the
    // affine part rather than a picture turned inside out.
    if ( !( pw * h.m[8] > 0 ) ) return [image imageByApplyingTransform:mat3AffinePart( h )];
    corners[i] = [CIVector vectorWithX:( h.m[0] * xs[i] + h.m[1] * ys[i] + h.m[2] ) / pw
                                     Y:( h.m[3] * xs[i] + h.m[4] * ys[i] + h.m[5] ) / pw];
  }
  CIFilter *filter = [CIFilter filterWithName:@"CIPerspectiveTransform"];
  [filter setValue:image forKey:kCIInputImageKey];
  [filter setValue:corners[0] forKey:@"inputTopLeft"];
  [filter setValue:corners[1] forKey:@"inputTopRight"];
  [filter setValue:corners[2] forKey:@"inputBottomRight"];
  [filter setValue:corners[3] forKey:@"inputBottomLeft"];
  return filter.outputImage ?: [image imageByApplyingTransform:mat3AffinePart( h )];
}

static NSArray<NSNumber *> *mat3Array( Mat3 h )
{
  NSMutableArray *a = [NSMutableArray arrayWithCapacity:9];
  for ( int i = 0; i < 9; i++ ) [a addObject:@( h.m[i] )];
  return a;
}
static NSError *stabilizerError( NSString *message )
{
  return [NSError errorWithDomain:@"VideoStabilizer" code:-1
                         userInfo:@{ NSLocalizedDescriptionKey: message }];
}

static CMTimeRange timeRangeFor( AVAsset *asset, NSDictionary *options )
{
  double duration = CMTimeGetSeconds( asset.duration );
  double start = MAX( 0, [options[@"start"] doubleValue] );
  double end = options[@"end"] ? [options[@"end"] doubleValue] : duration;
  if ( end <= start || end > duration ) end = duration;
  return CMTimeRangeFromTimeToTime( CMTimeMakeWithSeconds( start, 600 ), CMTimeMakeWithSeconds( end, 600 ) );
}

static double frameRateOf( AVAssetTrack *track )
{
  double fps = track.nominalFrameRate;
  if ( !( fps > 0 ) ) fps = 30;
  return MIN( fps, kMaxFrameRate );
}

// A reader of upright BGRA frames over `range`. Each pass builds its own, the
// same way, so their frames line up one to one.
static AVAssetReader *makeFrameReader(
  AVAsset *asset,
  CMTimeRange range,
  AVAssetReaderVideoCompositionOutput **outputOut,
  NSError **error
)
{
  NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
  if ( tracks.count == 0 ) {
    if ( error ) *error = stabilizerError( @"The file has no video track" );
    return nil;
  }
  AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:asset error:error];
  if ( !reader ) return nil;
  // Applies the track's preferred transform, so frames come out the way the
  // video is shown, not the way the sensor recorded it.
  AVMutableVideoComposition *composition = [AVMutableVideoComposition videoCompositionWithPropertiesOfAsset:asset];
  composition.frameDuration = CMTimeMake( 1000, (int32_t)round( frameRateOf( tracks.firstObject ) * 1000 ) );
  AVAssetReaderVideoCompositionOutput *output = [AVAssetReaderVideoCompositionOutput
    assetReaderVideoCompositionOutputWithVideoTracks:tracks
                                       videoSettings:@{
                                         (id)kCVPixelBufferPixelFormatTypeKey: @( kCVPixelFormatType_32BGRA ),
                                         (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                                       }];
  output.videoComposition = composition;
  output.alwaysCopiesSampleData = NO;
  if ( ![reader canAddOutput:output] ) {
    if ( error ) *error = stabilizerError( @"Could not read the video's frames" );
    return nil;
  }
  [reader addOutput:output];
  reader.timeRange = range;
  *outputOut = output;
  return reader;
}

static CVPixelBufferPoolRef makePixelBufferPool( size_t width, size_t height )
{
  NSDictionary *attributes = @{
    (id)kCVPixelBufferPixelFormatTypeKey: @( kCVPixelFormatType_32BGRA ),
    (id)kCVPixelBufferWidthKey: @( width ),
    (id)kCVPixelBufferHeightKey: @( height ),
    (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  CVPixelBufferPoolRef pool = NULL;
  CVPixelBufferPoolCreate( NULL, NULL, (__bridge CFDictionaryRef)attributes, &pool );
  return pool;
}
// Vision's registration transforms are in Core Image's bottom-left pixel
// space and map the targeted image onto the reference one. That reading was
// once settled by a vote on every analysis; every device log showed it as is,
// so it's now taken as given.
//
// Registers `targeted` against `reference`, returning the shift from the
// targeted image's bottom-left pixels onto the reference's. Only shifts are
// measured: rotation and zoom are left as they were shot.
static BOOL registerImages(
  CVPixelBufferRef targeted,
  CVPixelBufferRef reference,
  Mat3 *out
)
{
  VNImageRegistrationRequest *request =
    [[VNTranslationalImageRegistrationRequest alloc] initWithTargetedCVPixelBuffer:targeted options:@{}];
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:reference options:@{}];
  NSError *visionError = nil;
  id observation = [handler performRequests:@[request] error:&visionError]
    ? request.results.firstObject
    : nil;
  if ( [observation isKindOfClass:[VNImageTranslationAlignmentObservation class]] ) {
    *out = mat3FromAffine( ( (VNImageTranslationAlignmentObservation *)observation ).alignmentTransform );
    return YES;
  }
  return NO;
}
// ---- END COPIED ----


static const int kTileCols = 4;
static const int kTileRows = 4;
static const double kMidDimension = 960;

static CIContext *ctx;

static NSArray *pair( double x, double y ) { return @[ @( x ), @( y ) ]; }

// Registers two CIImages of the same size; shift in bottom-left pixels.
static BOOL registerCI( CIImage *targeted, CIImage *reference, double *dx, double *dy )
{
  VNTranslationalImageRegistrationRequest *request =
    [[VNTranslationalImageRegistrationRequest alloc] initWithTargetedCIImage:targeted options:@{}];
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCIImage:reference options:@{}];
  id observation = [handler performRequests:@[request] error:nil] ? request.results.firstObject : nil;
  if ( ![observation isKindOfClass:[VNImageTranslationAlignmentObservation class]] ) return NO;
  CGAffineTransform t = ( (VNImageTranslationAlignmentObservation *)observation ).alignmentTransform;
  *dx = t.tx;
  *dy = t.ty;
  return YES;
}

// The tile in column i, row j (row 0 at the top), moved to the origin.
static CIImage *tileOf( CIImage *image, int i, int j, double tw, double th, double height )
{
  double y = height - ( j + 1 ) * th;
  return [[image imageByCroppingToRect:CGRectMake( i * tw, y, tw, th )]
    imageByApplyingTransform:CGAffineTransformMakeTranslation( -i * tw, -y )];
}

static double median( NSMutableArray<NSNumber *> *v )
{
  [v sortUsingSelector:@selector( compare: )];
  NSUInteger n = v.count;
  return n % 2 ? v[n / 2].doubleValue : ( v[n / 2 - 1].doubleValue + v[n / 2].doubleValue ) / 2;
}

static NSDictionary *analyzeFile( NSString *path )
{
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  CMTimeRange range = CMTimeRangeMake( kCMTimeZero, asset.duration );
  AVAssetReaderVideoCompositionOutput *output = nil;
  NSError *error = nil;
  AVAssetReader *reader = makeFrameReader( asset, range, &output, &error );
  if ( !reader || ![reader startReading] ) {
    fprintf( stderr, "cannot read %s\n", path.UTF8String );
    exit( 1 );
  }
  // ---- the app's analyze(), background mode, strips off ----
  double maxDimension = 480;
  NSMutableArray<NSMutableDictionary *> *frames = [NSMutableArray array];
  NSMutableArray<NSValue *> *steps = [NSMutableArray array];
  NSMutableArray<NSValue *> *toFirst = [NSMutableArray array];
  CVPixelBufferPoolRef pool = NULL;
  CVPixelBufferRef previous = NULL;
  CVPixelBufferRef first = NULL;
  CIImage *blackSmall = nil;
  Mat3 chain = mat3Identity( );
  NSInteger refined = 0;
  size_t fullWidth = 0;
  size_t fullHeight = 0;
  double scale = 1;
  double smallWidth = 0;
  double smallHeight = 0;
  // ---- extra measurements ----
  double midScale = 1, midWidth = 0, midHeight = 0, tw = 0, th = 0;
  CIImage *firstMid = nil, *previousMid = nil, *blackMid = nil;
  double tcx = 0, tcy = 0;  // tile-chained shift onto the first frame, bottom-left mid px

  while ( YES ) {
    @autoreleasepool {
      CMSampleBufferRef sample = [output copyNextSampleBuffer];
      if ( !sample ) break;
      CVPixelBufferRef full = CMSampleBufferGetImageBuffer( sample );
      double t = CMTimeGetSeconds( CMSampleBufferGetPresentationTimeStamp( sample ) );
      if ( !pool ) {
        fullWidth = CVPixelBufferGetWidth( full );
        fullHeight = CVPixelBufferGetHeight( full );
        scale = MIN( 1, maxDimension / MAX( fullWidth, fullHeight ) );
        smallWidth = round( fullWidth * scale );
        smallHeight = round( fullHeight * scale );
        pool = makePixelBufferPool( (size_t)smallWidth, (size_t)smallHeight );
        blackSmall = [[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0]]
          imageByCroppingToRect:CGRectMake( 0, 0, smallWidth, smallHeight )];
        midScale = MIN( 1, kMidDimension / MAX( fullWidth, fullHeight ) );
        midWidth = round( fullWidth * midScale );
        midHeight = round( fullHeight * midScale );
        tw = floor( midWidth / kTileCols );
        th = floor( midHeight / kTileRows );
        blackMid = [[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0]]
          imageByCroppingToRect:CGRectMake( 0, 0, midWidth, midHeight )];
      }
      CVPixelBufferRef small = NULL;
      if ( pool ) CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &small );
      if ( !small ) {
        fprintf( stderr, "buffer failed\n" );
        exit( 1 );
      }
      CIImage *fullImage = [CIImage imageWithCVPixelBuffer:full];
      [ctx render:[fullImage imageByApplyingTransform:CGAffineTransformMakeScale( scale, scale )]
        toCVPixelBuffer:small];
      // The mid-size copy for the extra measurements, rendered to a bitmap so
      // it doesn't hold on to the sample.
      CGImageRef midCG = [ctx createCGImage:[fullImage imageByApplyingTransform:CGAffineTransformMakeScale( midScale, midScale )]
                                   fromRect:CGRectMake( 0, 0, midWidth, midHeight )];
      CIImage *mid = [CIImage imageWithCGImage:midCG];
      CGImageRelease( midCG );
      CFRelease( sample );

      NSMutableDictionary *frame = [@{ @"t": @( t ), @"ok": @YES } mutableCopy];
      Mat3 step = mat3Identity( );
      if ( previous && !registerImages( small, previous, &step ) ) {
        step = mat3Identity( );
        frame[@"ok"] = @NO;
      }
      [steps addObject:[NSValue valueWithBytes:&step objCType:@encode( Mat3 )]];

      // Vision's homographic registration onto the previous frame, raw
      // (bottom-left small px, row-major), to measure roll and zoom.
      if ( previous ) {
        VNHomographicImageRegistrationRequest *hr =
          [[VNHomographicImageRegistrationRequest alloc] initWithTargetedCVPixelBuffer:small options:@{}];
        VNImageRequestHandler *hh = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:previous options:@{}];
        id ho = [hh performRequests:@[hr] error:nil] ? hr.results.firstObject : nil;
        if ( [ho isKindOfClass:[VNImageHomographicAlignmentObservation class]] ) {
          matrix_float3x3 w = ( (VNImageHomographicAlignmentObservation *)ho ).warpTransform;
          NSMutableArray *rows = [NSMutableArray array];
          for ( int r = 0; r < 3; r++ ) {
            for ( int c = 0; c < 3; c++ ) [rows addObject:@( w.columns[c][r] )];
          }
          frame[@"h"] = rows;
        }
      }

      if ( !first ) {
        first = CVPixelBufferRetain( small );
      } else {
        chain = mat3Mul( chain, step );
        CVPixelBufferRef warped = NULL;
        CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &warped );
        if ( warped ) {
          CIImage *aligned = [warpImage( [CIImage imageWithCVPixelBuffer:small], chain )
            imageByCompositingOverImage:blackSmall];
          [ctx render:[aligned imageByCroppingToRect:blackSmall.extent] toCVPixelBuffer:warped];
          Mat3 residual;
          if ( registerImages( warped, first, &residual )
            && hypot( residual.m[2], residual.m[5] ) < 0.2 * MAX( smallWidth, smallHeight ) ) {
            chain = mat3Mul( residual, chain );
            refined += 1;
          }
          CVPixelBufferRelease( warped );
        }
      }
      [toFirst addObject:[NSValue valueWithBytes:&chain objCType:@encode( Mat3 )]];

      // ---- extra: tiles at mid size ----
      // ts: each tile's shift onto the same tile of the previous frame.
      // tr: each tile's shift onto the first frame, after the frame is moved
      //     by tc (the tile chain so far); its reading of the lock is tc + tr.
      // All top-left mid px. Null where Vision gave nothing, or (tr) where
      // the moved tile isn't wholly inside the frame.
      NSMutableArray *ts = [NSMutableArray array];
      NSMutableArray *tr = [NSMutableArray array];
      if ( previousMid ) {
        NSMutableArray<NSNumber *> *sx = [NSMutableArray array], *sy = [NSMutableArray array];
        for ( int j = 0; j < kTileRows; j++ ) {
          for ( int i = 0; i < kTileCols; i++ ) {
            double dx, dy;
            if ( registerCI( tileOf( mid, i, j, tw, th, midHeight ), tileOf( previousMid, i, j, tw, th, midHeight ), &dx, &dy ) ) {
              [ts addObject:pair( dx, -dy )];
              [sx addObject:@( dx )];
              [sy addObject:@( dy )];
            } else {
              [ts addObject:[NSNull null]];
            }
          }
        }
        if ( sx.count ) {
          tcx += median( sx );
          tcy += median( sy );
        }
        frame[@"tc"] = pair( tcx, -tcy );
        CIImage *aligned = [[[mid imageByApplyingTransform:CGAffineTransformMakeTranslation( tcx, tcy )]
          imageByCompositingOverImage:blackMid] imageByCroppingToRect:blackMid.extent];
        CGImageRef alignedCG = [ctx createCGImage:aligned fromRect:blackMid.extent];
        aligned = [CIImage imageWithCGImage:alignedCG];
        CGImageRelease( alignedCG );
        CGRect inside = CGRectIntersection( blackMid.extent, CGRectOffset( blackMid.extent, tcx, tcy ) );
        NSMutableArray<NSNumber *> *rx = [NSMutableArray array], *ry = [NSMutableArray array];
        for ( int j = 0; j < kTileRows; j++ ) {
          for ( int i = 0; i < kTileCols; i++ ) {
            CGRect tile = CGRectMake( i * tw, midHeight - ( j + 1 ) * th, tw, th );
            double dx, dy;
            if ( CGRectContainsRect( CGRectInset( inside, -0.5, -0.5 ), tile )
              && registerCI( tileOf( aligned, i, j, tw, th, midHeight ), tileOf( firstMid, i, j, tw, th, midHeight ), &dx, &dy ) ) {
              [tr addObject:pair( dx, -dy )];
              [rx addObject:@( dx )];
              [ry addObject:@( dy )];
            } else {
              [tr addObject:[NSNull null]];
            }
          }
        }
        if ( rx.count >= 3 ) {
          double mx = median( rx ), my = median( ry );
          if ( hypot( mx, my ) < 0.1 * MAX( midWidth, midHeight ) ) {
            tcx += mx;
            tcy += my;
          }
        }
        frame[@"ts"] = ts;
        frame[@"tr"] = tr;
      } else {
        firstMid = mid;
      }
      previousMid = mid;

      if ( previous ) CVPixelBufferRelease( previous );
      previous = small;
      [frames addObject:frame];
    }
  }
  if ( reader.status == AVAssetReaderStatusFailed || frames.count == 0 ) {
    fprintf( stderr, "read failed: %s\n", reader.error.localizedDescription.UTF8String );
    exit( 1 );
  }
  Mat3 toTopLeft = mat3Mul( mat3Scale( 1 / scale ), mat3FlipY( smallHeight ) );
  Mat3 fromTopLeft = mat3Inv( toTopLeft );
  for ( NSUInteger i = 0; i < frames.count; i++ ) {
    Mat3 step;
    [steps[i] getValue:&step];
    frames[i][@"m"] = mat3Array( mat3Mul( toTopLeft, mat3Mul( i == 0 ? mat3Identity( ) : step, fromTopLeft ) ) );
    Mat3 r;
    [toFirst[i] getValue:&r];
    frames[i][@"r"] = mat3Array( mat3Mul( toTopLeft, mat3Mul( r, fromTopLeft ) ) );
  }
  if ( previous ) CVPixelBufferRelease( previous );
  if ( first ) CVPixelBufferRelease( first );
  if ( pool ) CVPixelBufferPoolRelease( pool );
  return @{
    @"width": @( fullWidth ), @"height": @( fullHeight ),
    @"scale": @( scale ), @"smallWidth": @( smallWidth ), @"smallHeight": @( smallHeight ),
    @"midScale": @( midScale ), @"midWidth": @( midWidth ), @"midHeight": @( midHeight ),
    @"tileWidth": @( tw ), @"tileHeight": @( th ), @"tileCols": @( kTileCols ), @"tileRows": @( kTileRows ),
    @"refined": @( refined ), @"frames": frames,
  };
}

int main( int argc, const char *argv[] )
{
  @autoreleasepool {
    ctx = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    if ( argc < 2 ) {
      fprintf( stderr, "usage: analyze clip.mov\n" );
      return 2;
    }
    NSDate *start = [NSDate date];
    NSMutableDictionary *result = [analyzeFile( [NSString stringWithUTF8String:argv[1]] ) mutableCopy];
    result[@"seconds"] = @( -start.timeIntervalSinceNow );
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    fwrite( json.bytes, 1, json.length, stdout );
    fprintf( stderr, "%s: %lu frames, %ld refined, %.1f s\n", argv[1],
      (unsigned long)[result[@"frames"] count], (long)[result[@"refined"] integerValue], [result[@"seconds"] doubleValue] );
  }
  return 0;
}
