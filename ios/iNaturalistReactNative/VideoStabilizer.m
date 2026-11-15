#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreImage/CoreImage.h>
#import <PhotosUI/PhotosUI.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <Vision/Vision.h>

// The measuring and rendering half of the video stabilizer; the camera-path
// math lives in JS (sharedHelpers/videoStabilization.ts).
//
//   pickVideo  copies a video from Photos or Files into the working folder
//   probe      upright size, duration, frame rate
//   frameAt    a JPEG of one frame, for choosing the subject and the crop
//   analyze    one pass over the frames, reporting per frame either how the
//              picture moved since the previous frame (Vision image
//              registration) or where the subject is (Vision object tracker,
//              or the most salient object)
//   render     a second pass that warps each frame by the affine JS computed
//              for it, crops to the output size and writes an H.264 .mov,
//              passing the audio through untouched
//
// Both passes read frames through the same AVAssetReaderVideoCompositionOutput
// (upright, constant frame rate, same time range), so frame i of the analysis
// is frame i of the render. All coordinates crossing the bridge are pixels of
// the upright full-size frame with the origin top-left; Core Image and Vision
// work bottom-left, and the conversions happen here.

static NSString *const kProgressEvent = @"VideoStabilizerProgress";
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

static NSArray<NSNumber *> *mat3Array( Mat3 h )
{
  NSMutableArray *a = [NSMutableArray arrayWithCapacity:9];
  for ( int i = 0; i < 9; i++ ) [a addObject:@( h.m[i] )];
  return a;
}

static NSString *stripFileScheme( NSString *path )
{
  return [path hasPrefix:@"file://"] ? [path substringFromIndex:7] : path;
}

static NSString *workingDirectory( void )
{
  NSString *caches = NSSearchPathForDirectoriesInDomains( NSCachesDirectory, NSUserDomainMask, YES ).firstObject;
  return [caches stringByAppendingPathComponent:@"VideoStabilizer"];
}

// Removes files in the working folder whose names start with `prefix`.
static void removeWorkingFiles( NSString *prefix )
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *dir = workingDirectory( );
  for ( NSString *name in [fm contentsOfDirectoryAtPath:dir error:nil] ) {
    if ( [name hasPrefix:prefix] ) {
      [fm removeItemAtPath:[dir stringByAppendingPathComponent:name] error:nil];
    }
  }
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

static CGFloat iou( CGRect a, CGRect b )
{
  CGRect i = CGRectIntersection( a, b );
  if ( CGRectIsNull( i ) ) return 0;
  CGFloat inter = i.size.width * i.size.height;
  CGFloat uni = a.size.width * a.size.height + b.size.width * b.size.height - inter;
  return uni > 0 ? inter / uni : 0;
}

static NSArray<NSNumber *> *topLeftBox( CGRect bottomLeft )
{
  return @[
    @( bottomLeft.origin.x ),
    @( 1 - bottomLeft.origin.y - bottomLeft.size.height ),
    @( bottomLeft.size.width ),
    @( bottomLeft.size.height ),
  ];
}

@interface VideoStabilizer : RCTEventEmitter <RCTBridgeModule, PHPickerViewControllerDelegate,
  UIDocumentPickerDelegate>
@end

@implementation VideoStabilizer {
  RCTPromiseResolveBlock _pickResolve;
  RCTPromiseRejectBlock _pickReject;
  BOOL _hasListeners;
  volatile BOOL _cancelled;
  dispatch_queue_t _queue;
  CIContext *_ciContext;
  CFAbsoluteTime _lastProgressAt;
}

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents { return @[kProgressEvent]; }

- (void)startObserving { _hasListeners = YES; }

- (void)stopObserving { _hasListeners = NO; }

- (instancetype)init
{
  if ( ( self = [super init] ) ) {
    _queue = dispatch_queue_create( "org.inaturalist.videostabilizer", DISPATCH_QUEUE_SERIAL );
    _ciContext = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
  }
  return self;
}

- (void)emitProgress:(NSString *)phase progress:(double)progress force:(BOOL)force
{
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent( );
  if ( !_hasListeners || ( !force && now - _lastProgressAt < 0.1 ) ) return;
  _lastProgressAt = now;
  [self sendEventWithName:kProgressEvent body:@{
    @"phase": phase,
    @"progress": @( MAX( 0, MIN( 1, progress ) ) ),
  }];
}

// ─── Import ──────────────────────────────────────────────────────────────────

- (void)finishPickWithPath:(NSString *)path error:(NSError *)error
{
  RCTPromiseResolveBlock resolve = _pickResolve;
  RCTPromiseRejectBlock reject = _pickReject;
  _pickResolve = nil;
  _pickReject = nil;
  if ( error ) {
    if ( reject ) reject( @"PICK_FAILED", error.localizedDescription, error );
  } else if ( resolve ) {
    resolve( path ?: (id)[NSNull null] );
  }
}

// One video at a time: importing a new one clears out the last one's files.
static NSString *importVideoFile( NSURL *url, NSError **error )
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *dir = workingDirectory( );
  [fm removeItemAtPath:dir error:nil];
  [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *ext = url.pathExtension.length > 0 ? url.pathExtension : @"mov";
  NSString *dest = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"input-%@.%@",
    [NSUUID UUID].UUIDString, ext]];
  if ( ![fm copyItemAtPath:url.path toPath:dest error:error] ) return nil;
  return dest;
}

RCT_EXPORT_METHOD( pickVideo
                  : ( NSString * )source resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue( ), ^{
    if ( self->_pickResolve ) {
      reject( @"PICK_BUSY", @"A picker is already open", nil );
      return;
    }
    self->_pickResolve = resolve;
    self->_pickReject = reject;
    UIViewController *picker;
    if ( [source isEqualToString:@"files"] ) {
      UIDocumentPickerViewController *documents = [[UIDocumentPickerViewController alloc]
        initForOpeningContentTypes:@[UTTypeMovie] asCopy:YES];
      documents.delegate = self;
      picker = documents;
    } else {
      // The system picker needs no Photos permission. "Current" hands over
      // the file as stored, instead of transcoding it to H.264 first.
      PHPickerConfiguration *config = [[PHPickerConfiguration alloc] init];
      config.filter = [PHPickerFilter videosFilter];
      config.selectionLimit = 1;
      config.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
      PHPickerViewController *library = [[PHPickerViewController alloc] initWithConfiguration:config];
      library.delegate = self;
      picker = library;
    }
    [RCTPresentedViewController( ) presentViewController:picker animated:YES completion:nil];
  } );
}

- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results
{
  [picker dismissViewControllerAnimated:YES completion:nil];
  NSItemProvider *provider = results.firstObject.itemProvider;
  if ( !provider ) {
    [self finishPickWithPath:nil error:nil];
    return;
  }
  NSString *type = UTTypeMovie.identifier;
  for ( NSString *identifier in provider.registeredTypeIdentifiers ) {
    if ( [[UTType typeWithIdentifier:identifier] conformsToType:UTTypeMovie] ) {
      type = identifier;
      break;
    }
  }
  // The file handed over is deleted when this handler returns, so it's
  // copied before then. For a video in iCloud this waits on the download.
  [provider loadFileRepresentationForTypeIdentifier:type completionHandler:^( NSURL *url, NSError *error ) {
    NSError *copyError = error;
    NSString *path = url ? importVideoFile( url, &copyError ) : nil;
    dispatch_async( dispatch_get_main_queue( ), ^{
      [self finishPickWithPath:path error:path ? nil : ( copyError ?: stabilizerError( @"Could not load the video" ) )];
    } );
  }];
}

- (void)documentPicker:(__unused UIDocumentPickerViewController *)controller
  didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  NSURL *url = urls.firstObject;
  NSError *error = nil;
  NSString *path = url ? importVideoFile( url, &error ) : nil;
  if ( url ) [[NSFileManager defaultManager] removeItemAtURL:url error:nil];
  [self finishPickWithPath:path error:url && !path ? error : nil];
}

- (void)documentPickerWasCancelled:(__unused UIDocumentPickerViewController *)controller
{
  [self finishPickWithPath:nil error:nil];
}

// ─── Inspection ──────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD( probe
                  : ( NSString * )path resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _queue, ^{
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( path )] options:nil];
    AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if ( !track ) {
      reject( @"PROBE_FAILED", @"The file has no video track", nil );
      return;
    }
    CGRect upright = CGRectApplyAffineTransform(
      CGRectMake( 0, 0, track.naturalSize.width, track.naturalSize.height ), track.preferredTransform );
    resolve( @{
      @"width": @( round( fabs( upright.size.width ) ) ),
      @"height": @( round( fabs( upright.size.height ) ) ),
      @"duration": @( CMTimeGetSeconds( asset.duration ) ),
      @"fps": @( frameRateOf( track ) ),
      @"hasAudio": @( [asset tracksWithMediaType:AVMediaTypeAudio].count > 0 ),
    } );
  } );
}

RCT_EXPORT_METHOD( frameAt
                  : ( NSString * )path seconds
                  : ( double )seconds maxDimension
                  : ( double )maxDimension resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _queue, ^{
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( path )] options:nil];
    AVAssetImageGenerator *generator = [[AVAssetImageGenerator alloc] initWithAsset:asset];
    generator.appliesPreferredTrackTransform = YES;
    generator.maximumSize = CGSizeMake( maxDimension, maxDimension );
    generator.requestedTimeToleranceBefore = kCMTimeZero;
    generator.requestedTimeToleranceAfter = kCMTimeZero;
    NSError *error = nil;
    CGImageRef image = [generator copyCGImageAtTime:CMTimeMakeWithSeconds( seconds, 600 ) actualTime:NULL error:&error];
    if ( !image ) {
      reject( @"FRAME_FAILED", error.localizedDescription ?: @"Could not read the frame", error );
      return;
    }
    NSData *jpeg = UIImageJPEGRepresentation( [UIImage imageWithCGImage:image], 0.85 );
    size_t width = CGImageGetWidth( image );
    size_t height = CGImageGetHeight( image );
    CGImageRelease( image );
    // A new name every time: React Native caches images by URI.
    [[NSFileManager defaultManager] createDirectoryAtPath:workingDirectory( )
                              withIntermediateDirectories:YES attributes:nil error:nil];
    removeWorkingFiles( @"frame-" );
    NSString *dest = [workingDirectory( ) stringByAppendingPathComponent:
      [NSString stringWithFormat:@"frame-%@.jpg", [NSUUID UUID].UUIDString]];
    if ( ![jpeg writeToFile:dest atomically:YES] ) {
      reject( @"FRAME_FAILED", @"Could not save the frame", nil );
      return;
    }
    resolve( @{
      @"uri": [@"file://" stringByAppendingString:dest],
      @"width": @( width ),
      @"height": @( height ),
    } );
  } );
}

RCT_EXPORT_METHOD( cancel )
{
  _cancelled = YES;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

// Mean color difference between two images over `rect`.
- (double)differenceOf:(CIImage *)a and:(CIImage *)b inRect:(CGRect)rect
{
  CIFilter *difference = [CIFilter filterWithName:@"CIDifferenceBlendMode"];
  [difference setValue:a forKey:kCIInputImageKey];
  [difference setValue:b forKey:kCIInputBackgroundImageKey];
  CIFilter *average = [CIFilter filterWithName:@"CIAreaAverage"];
  [average setValue:[difference.outputImage imageByCroppingToRect:rect] forKey:kCIInputImageKey];
  [average setValue:[CIVector vectorWithCGRect:rect] forKey:kCIInputExtentKey];
  float pixel[4] = { 0, 0, 0, 0 };
  [_ciContext render:average.outputImage toBitmap:pixel rowBytes:sizeof( pixel )
              bounds:average.outputImage.extent format:kCIFormatRGBAf colorSpace:nil];
  return pixel[0] + pixel[1] + pixel[2];
}

// Vision's registration transforms are reported in Core Image's bottom-left
// pixel space, mapping the targeted image (this frame) onto the reference
// (the previous frame) — but which way round, and which way up, isn't spelled
// out in the documentation, and a wrong guess turns stabilization into double
// shake. So it's measured: on frames that moved, each reading of the
// transform is applied to this frame and compared with the previous one, and
// the reading that lines them up best wins a vote.
typedef NS_ENUM( NSInteger, RegistrationReading ) {
  RegistrationReadingAsIs = 0,
  RegistrationReadingInverse,
  RegistrationReadingFlipped,
  RegistrationReadingFlippedInverse,
  RegistrationReadingCount,
};

static Mat3 readRegistration( Mat3 raw, RegistrationReading reading, double height )
{
  Mat3 flip = mat3FlipY( height );
  switch ( reading ) {
    case RegistrationReadingInverse: return mat3Inv( raw );
    case RegistrationReadingFlipped: return mat3Mul( flip, mat3Mul( raw, flip ) );
    case RegistrationReadingFlippedInverse: return mat3Mul( flip, mat3Mul( mat3Inv( raw ), flip ) );
    default: return raw;
  }
}

- (RegistrationReading)bestReadingOf:(Mat3)raw current:(CIImage *)current previous:(CIImage *)previous
{
  CGRect extent = previous.extent;
  CGRect center = CGRectInset( extent, extent.size.width * 0.25, extent.size.height * 0.25 );
  RegistrationReading best = RegistrationReadingAsIs;
  double bestScore = DBL_MAX;
  for ( NSInteger reading = 0; reading < RegistrationReadingCount; reading++ ) {
    Mat3 m = readRegistration( raw, (RegistrationReading)reading, extent.size.height );
    CIImage *aligned = [current imageByApplyingTransform:mat3AffinePart( m )];
    double score = [self differenceOf:aligned and:previous inRect:center];
    if ( score < bestScore ) {
      bestScore = score;
      best = (RegistrationReading)reading;
    }
  }
  return best;
}

RCT_EXPORT_METHOD( analyze
                  : ( NSString * )path options
                  : ( NSDictionary * )options resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  _cancelled = NO;
  dispatch_async( _queue, ^{
    NSString *method = options[@"method"] ?: @"translation";
    BOOL subject = [method isEqualToString:@"tracker"] || [method isEqualToString:@"saliency"];
    // Registration needs little detail; the tracker does better with more.
    double maxDimension = subject ? 720 : 480;
    NSArray<NSNumber *> *initialBox = options[@"box"];
    if ( [method isEqualToString:@"tracker"] && initialBox.count != 4 ) {
      reject( @"ANALYZE_FAILED", @"Draw a box around the subject first", nil );
      return;
    }

    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( path )] options:nil];
    CMTimeRange range = timeRangeFor( asset, options );
    double rangeSeconds = MAX( 0.001, CMTimeGetSeconds( range.duration ) );
    AVAssetReaderVideoCompositionOutput *output = nil;
    NSError *error = nil;
    AVAssetReader *reader = makeFrameReader( asset, range, &output, &error );
    if ( !reader || ![reader startReading] ) {
      reject( @"ANALYZE_FAILED", ( error ?: reader.error ).localizedDescription ?: @"Could not read the video", error );
      return;
    }

    NSMutableArray<NSDictionary *> *frames = [NSMutableArray array];
    NSMutableArray<NSValue *> *rawSteps = [NSMutableArray array];  // background: Mat3 per frame
    NSInteger votes[RegistrationReadingCount] = { 0 };
    NSInteger votesCast = 0;
    CVPixelBufferPoolRef pool = NULL;
    CVPixelBufferRef previous = NULL;
    size_t fullWidth = 0;
    size_t fullHeight = 0;
    double scale = 1;
    double smallHeight = 0;
    VNSequenceRequestHandler *sequence = [[VNSequenceRequestHandler alloc] init];
    VNTrackObjectRequest *track = nil;
    CGRect lastBox = CGRectNull;  // bottom-left normalized
    BOOL bufferFailed = NO;
    if ( initialBox.count == 4 ) {
      lastBox = CGRectMake( initialBox[0].doubleValue,
                            1 - initialBox[1].doubleValue - initialBox[3].doubleValue,
                            initialBox[2].doubleValue, initialBox[3].doubleValue );
    }

    while ( !self->_cancelled ) {
      @autoreleasepool {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if ( !sample ) break;
        CVPixelBufferRef full = CMSampleBufferGetImageBuffer( sample );
        double t = CMTimeGetSeconds( CMSampleBufferGetPresentationTimeStamp( sample ) );
        if ( !pool ) {
          fullWidth = CVPixelBufferGetWidth( full );
          fullHeight = CVPixelBufferGetHeight( full );
          scale = MIN( 1, maxDimension / MAX( fullWidth, fullHeight ) );
          pool = makePixelBufferPool( (size_t)round( fullWidth * scale ), (size_t)round( fullHeight * scale ) );
          smallHeight = round( fullHeight * scale );
        }
        CVPixelBufferRef small = NULL;
        if ( pool ) CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &small );
        if ( !small ) {
          CFRelease( sample );
          bufferFailed = YES;
          break;
        }
        CIImage *fullImage = [CIImage imageWithCVPixelBuffer:full];
        [self->_ciContext render:[fullImage imageByApplyingTransform:CGAffineTransformMakeScale( scale, scale )]
                 toCVPixelBuffer:small];
        CFRelease( sample );

        NSMutableDictionary *frame = [@{ @"t": @( t ), @"ok": @YES } mutableCopy];
        if ( !subject ) {
          Mat3 step = mat3Identity( );
          if ( previous ) {
            VNImageRegistrationRequest *request;
            if ( [method isEqualToString:@"similarity"] ) {
              request = [[VNHomographicImageRegistrationRequest alloc] initWithTargetedCVPixelBuffer:small
                                                                                            options:@{}];
            } else {
              request = [[VNTranslationalImageRegistrationRequest alloc] initWithTargetedCVPixelBuffer:small
                                                                                              options:@{}];
            }
            VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:previous options:@{}];
            NSError *visionError = nil;
            id observation = [handler performRequests:@[request] error:&visionError]
              ? request.results.firstObject
              : nil;
            if ( [observation isKindOfClass:[VNImageHomographicAlignmentObservation class]] ) {
              matrix_float3x3 w = ( (VNImageHomographicAlignmentObservation *)observation ).warpTransform;
              for ( int r = 0; r < 3; r++ ) {
                for ( int c = 0; c < 3; c++ ) step.m[r * 3 + c] = w.columns[c][r];
              }
              // simd matrices are column-major for column vectors; if the
              // pixel-sized shift turns up in the bottom row instead of the
              // right column, the matrix is for row vectors and is transposed.
              if ( fabs( step.m[6] ) + fabs( step.m[7] ) > fabs( step.m[2] ) + fabs( step.m[5] ) + 1e-3 ) {
                Mat3 transposed;
                for ( int r = 0; r < 3; r++ ) {
                  for ( int c = 0; c < 3; c++ ) transposed.m[r * 3 + c] = step.m[c * 3 + r];
                }
                step = transposed;
              }
            } else if ( [observation isKindOfClass:[VNImageTranslationAlignmentObservation class]] ) {
              CGAffineTransform a = ( (VNImageTranslationAlignmentObservation *)observation ).alignmentTransform;
              Mat3 m = { { a.a, a.c, a.tx, a.b, a.d, a.ty, 0, 0, 1 } };
              step = m;
            } else {
              frame[@"ok"] = @NO;
            }
            BOOL moved = hypot( step.m[2], step.m[5] ) > 2;
            if ( [frame[@"ok"] boolValue] && moved && votesCast < 9 ) {
              CIImage *current = [CIImage imageWithCVPixelBuffer:small];
              CIImage *before = [CIImage imageWithCVPixelBuffer:previous];
              votes[[self bestReadingOf:step current:current previous:before]] += 1;
              votesCast += 1;
            }
          }
          [rawSteps addObject:[NSValue valueWithBytes:&step objCType:@encode( Mat3 )]];
        } else if ( [method isEqualToString:@"tracker"] ) {
          if ( frames.count == 0 ) {
            track = [[VNTrackObjectRequest alloc] initWithDetectedObjectObservation:
              [VNDetectedObjectObservation observationWithBoundingBox:lastBox]];
            track.trackingLevel = VNRequestTrackingLevelAccurate;
            frame[@"box"] = topLeftBox( lastBox );
            frame[@"conf"] = @1;
          } else {
            NSError *visionError = nil;
            [sequence performRequests:@[track] onCVPixelBuffer:small error:&visionError];
            id result = track.results.firstObject;
            VNDetectedObjectObservation *found = [result isKindOfClass:[VNDetectedObjectObservation class]]
              ? (VNDetectedObjectObservation *)result
              : nil;
            if ( found ) {
              frame[@"box"] = topLeftBox( found.boundingBox );
              frame[@"conf"] = @( found.confidence );
              // A low-confidence box is usually the tracker latching onto
              // the background; keep tracking from the last good one.
              if ( found.confidence >= 0.3 ) track.inputObservation = found;
            } else {
              frame[@"ok"] = @NO;
            }
          }
        } else {
          VNGenerateObjectnessBasedSaliencyImageRequest *request = [[VNGenerateObjectnessBasedSaliencyImageRequest alloc] init];
          VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:small options:@{}];
          NSError *visionError = nil;
          [handler performRequests:@[request] error:&visionError];
          id result = request.results.firstObject;
          VNSaliencyImageObservation *saliency = [result isKindOfClass:[VNSaliencyImageObservation class]]
            ? (VNSaliencyImageObservation *)result
            : nil;
          VNRectangleObservation *best = nil;
          CGFloat bestScore = -CGFLOAT_MAX;
          for ( VNRectangleObservation *candidate in saliency.salientObjects ) {
            CGRect box = candidate.boundingBox;
            CGFloat score;
            if ( CGRectIsNull( lastBox ) ) {
              score = box.size.width * box.size.height;
            } else {
              // Stick with the object followed so far; failing any overlap,
              // the nearest one.
              CGFloat overlap = iou( box, lastBox );
              score = overlap > 0
                ? overlap
                : -hypot( CGRectGetMidX( box ) - CGRectGetMidX( lastBox ), CGRectGetMidY( box ) - CGRectGetMidY( lastBox ) );
            }
            if ( score > bestScore ) {
              bestScore = score;
              best = candidate;
            }
          }
          if ( best ) {
            lastBox = best.boundingBox;
            frame[@"box"] = topLeftBox( lastBox );
            frame[@"conf"] = @( best.confidence );
          } else {
            frame[@"ok"] = @NO;
          }
        }

        if ( previous ) CVPixelBufferRelease( previous );
        previous = small;
        [frames addObject:frame];
        [self emitProgress:@"analyze" progress:( t - CMTimeGetSeconds( range.start ) ) / rangeSeconds force:NO];
      }
    }
    if ( previous ) CVPixelBufferRelease( previous );
    if ( pool ) CVPixelBufferPoolRelease( pool );

    if ( self->_cancelled ) {
      [reader cancelReading];
      reject( @"CANCELLED", @"Cancelled", nil );
      return;
    }
    if ( bufferFailed ) [reader cancelReading];
    if ( bufferFailed || reader.status == AVAssetReaderStatusFailed || frames.count == 0 ) {
      reject( @"ANALYZE_FAILED", reader.error.localizedDescription ?: @"No frames could be read", reader.error );
      return;
    }

    NSString *readingName = @"";
    if ( !subject ) {
      RegistrationReading reading = RegistrationReadingAsIs;
      for ( NSInteger r = 1; r < RegistrationReadingCount; r++ ) {
        if ( votes[r] > votes[reading] ) reading = (RegistrationReading)r;
      }
      readingName = @[@"as-is", @"inverse", @"flipped", @"flipped-inverse"][reading];
      // Bottom-left pixels of the small frame → top-left pixels of the full one.
      Mat3 toTopLeft = mat3Mul( mat3Scale( 1 / scale ), mat3FlipY( smallHeight ) );
      Mat3 fromTopLeft = mat3Inv( toTopLeft );
      for ( NSUInteger i = 0; i < frames.count; i++ ) {
        Mat3 raw;
        [rawSteps[i] getValue:&raw];
        Mat3 step = i == 0 ? mat3Identity( ) : readRegistration( raw, reading, smallHeight );
        NSMutableDictionary *withStep = [frames[i] mutableCopy];
        withStep[@"m"] = mat3Array( mat3Mul( toTopLeft, mat3Mul( step, fromTopLeft ) ) );
        frames[i] = withStep;
      }
    }

    [self emitProgress:@"analyze" progress:1 force:YES];
    resolve( @{
      @"method": method,
      @"width": @( fullWidth ),
      @"height": @( fullHeight ),
      @"fps": @( frameRateOf( [asset tracksWithMediaType:AVMediaTypeVideo].firstObject ) ),
      @"frames": frames,
      // Which reading of Vision's registration transform won (see above),
      // logged by JS so a fixed convention can replace the vote one day.
      @"registrationReading": readingName,
      @"registrationVotes": @( votesCast ),
    } );
  } );
}

// ─── Rendering ───────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD( render
                  : ( NSString * )path options
                  : ( NSDictionary * )options resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  _cancelled = NO;
  dispatch_async( _queue, ^{
    NSArray<NSNumber *> *flat = options[@"transforms"];
    NSInteger outWidth = [options[@"outputWidth"] integerValue];
    NSInteger outHeight = [options[@"outputHeight"] integerValue];
    NSString *prefix = [options[@"preview"] boolValue] ? @"preview-" : @"stabilized-";
    NSInteger transformCount = (NSInteger)flat.count / 6;
    if ( transformCount == 0 || outWidth < 2 || outHeight < 2 ) {
      reject( @"RENDER_FAILED", @"Nothing to render", nil );
      return;
    }
    double *transforms = malloc( sizeof( double ) * transformCount * 6 );
    for ( NSInteger i = 0; i < transformCount * 6; i++ ) transforms[i] = flat[i].doubleValue;

    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( path )] options:nil];
    CMTimeRange range = timeRangeFor( asset, options );
    double rangeSeconds = MAX( 0.001, CMTimeGetSeconds( range.duration ) );
    AVAssetTrack *videoTrack = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    double fps = frameRateOf( videoTrack );
    AVAssetReaderVideoCompositionOutput *videoOutput = nil;
    NSError *error = nil;
    AVAssetReader *reader = makeFrameReader( asset, range, &videoOutput, &error );
    if ( !reader ) {
      free( transforms );
      reject( @"RENDER_FAILED", error.localizedDescription, error );
      return;
    }

    removeWorkingFiles( prefix );
    NSString *outPath = [workingDirectory( ) stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%@%@.mov", prefix, [NSUUID UUID].UUIDString]];
    AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:outPath]
                                                     fileType:AVFileTypeQuickTimeMovie error:&error];
    if ( !writer ) {
      free( transforms );
      reject( @"RENDER_FAILED", error.localizedDescription, error );
      return;
    }
    // About 0.15 bits per pixel per frame: 1080p30 at ~9 Mb/s.
    double bitrate = MIN( 50e6, MAX( 2e6, 0.15 * outWidth * outHeight * fps ) );
    AVAssetWriterInput *videoInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{
      AVVideoCodecKey: AVVideoCodecTypeH264,
      AVVideoWidthKey: @( outWidth ),
      AVVideoHeightKey: @( outHeight ),
      AVVideoCompressionPropertiesKey: @{
        AVVideoAverageBitRateKey: @( bitrate ),
        AVVideoExpectedSourceFrameRateKey: @( fps ),
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
      },
    }];
    videoInput.expectsMediaDataInRealTime = NO;
    AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor
      assetWriterInputPixelBufferAdaptorWithAssetWriterInput:videoInput
                                 sourcePixelBufferAttributes:@{
                                   (id)kCVPixelBufferPixelFormatTypeKey: @( kCVPixelFormatType_32BGRA ),
                                   (id)kCVPixelBufferWidthKey: @( outWidth ),
                                   (id)kCVPixelBufferHeightKey: @( outHeight ),
                                   (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                                 }];
    [writer addInput:videoInput];

    // Audio is copied as-is: the picture is warped, not retimed.
    AVAssetReaderTrackOutput *audioOutput = nil;
    AVAssetWriterInput *audioInput = nil;
    AVAssetTrack *audioTrack = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    if ( audioTrack && [options[@"includeAudio"] boolValue] ) {
      audioOutput = [AVAssetReaderTrackOutput assetReaderTrackOutputWithTrack:audioTrack outputSettings:nil];
      audioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio outputSettings:nil
        sourceFormatHint:(__bridge CMFormatDescriptionRef)audioTrack.formatDescriptions.firstObject];
      audioInput.expectsMediaDataInRealTime = NO;
      if ( [reader canAddOutput:audioOutput] && [writer canAddInput:audioInput] ) {
        [reader addOutput:audioOutput];
        [writer addInput:audioInput];
      } else {
        audioOutput = nil;
        audioInput = nil;
      }
    }

    if ( ![reader startReading] || ![writer startWriting] ) {
      free( transforms );
      NSError *startError = reader.error ?: writer.error;
      reject( @"RENDER_FAILED", startError.localizedDescription ?: @"Could not start rendering", startError );
      return;
    }
    [writer startSessionAtSourceTime:range.start];

    CGRect outRect = CGRectMake( 0, 0, outWidth, outHeight );
    CIImage *black = [[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0]] imageByCroppingToRect:outRect];
    CGColorSpaceRef sRGB = CGColorSpaceCreateWithName( kCGColorSpaceSRGB );
    dispatch_group_t group = dispatch_group_create( );
    __block NSInteger index = 0;
    __block BOOL videoDone = NO;
    __block BOOL appendFailed = NO;

    // The writer interleaves audio and video, so each input is fed from its
    // own queue as it asks; filling one first can stall it waiting on the other.
    dispatch_group_enter( group );
    [videoInput requestMediaDataWhenReadyOnQueue:dispatch_queue_create( "org.inaturalist.videostabilizer.video", NULL )
                                      usingBlock:^{
      while ( !videoDone && videoInput.isReadyForMoreMediaData ) {
        @autoreleasepool {
          CMSampleBufferRef sample = self->_cancelled ? NULL : [videoOutput copyNextSampleBuffer];
          if ( !sample ) {
            videoDone = YES;
            [videoInput markAsFinished];
            dispatch_group_leave( group );
            break;
          }
          CVPixelBufferRef source = CMSampleBufferGetImageBuffer( sample );
          CMTime pts = CMSampleBufferGetPresentationTimeStamp( sample );
          const double *m = transforms + MIN( index, transformCount - 1 ) * 6;
          // JS's affine is top-left source pixels → top-left output pixels;
          // Core Image needs it between the two bottom-left spaces.
          CGAffineTransform topLeft = CGAffineTransformMake( m[0], m[1], m[2], m[3], m[4], m[5] );
          CGAffineTransform flipIn = CGAffineTransformMake( 1, 0, 0, -1, 0, CVPixelBufferGetHeight( source ) );
          CGAffineTransform flipOut = CGAffineTransformMake( 1, 0, 0, -1, 0, outHeight );
          CGAffineTransform warp = CGAffineTransformConcat( CGAffineTransformConcat( flipIn, topLeft ), flipOut );
          CIImage *frame = [[[CIImage imageWithCVPixelBuffer:source] imageByApplyingTransform:warp]
            imageByCroppingToRect:outRect];
          CVPixelBufferRef target = NULL;
          CVPixelBufferPoolCreatePixelBuffer( NULL, adaptor.pixelBufferPool, &target );
          if ( target ) {
            [self->_ciContext render:[frame imageByCompositingOverImage:black] toCVPixelBuffer:target
                              bounds:outRect colorSpace:sRGB];
            if ( ![adaptor appendPixelBuffer:target withPresentationTime:pts] ) appendFailed = YES;
            CVPixelBufferRelease( target );
          }
          CFRelease( sample );
          index += 1;
          [self emitProgress:@"render"
                    progress:( CMTimeGetSeconds( pts ) - CMTimeGetSeconds( range.start ) ) / rangeSeconds
                       force:NO];
          if ( appendFailed ) {
            videoDone = YES;
            [videoInput markAsFinished];
            dispatch_group_leave( group );
            break;
          }
        }
      }
    }];

    if ( audioInput ) {
      __block BOOL audioDone = NO;
      dispatch_group_enter( group );
      [audioInput requestMediaDataWhenReadyOnQueue:dispatch_queue_create( "org.inaturalist.videostabilizer.audio", NULL )
                                        usingBlock:^{
        while ( !audioDone && audioInput.isReadyForMoreMediaData ) {
          CMSampleBufferRef sample = ( self->_cancelled || appendFailed ) ? NULL : [audioOutput copyNextSampleBuffer];
          if ( !sample || ![audioInput appendSampleBuffer:sample] ) {
            if ( sample ) CFRelease( sample );
            audioDone = YES;
            [audioInput markAsFinished];
            dispatch_group_leave( group );
            break;
          }
          CFRelease( sample );
        }
      }];
    }

    dispatch_group_notify( group, self->_queue, ^{
      free( transforms );
      CGColorSpaceRelease( sRGB );
      if ( self->_cancelled || appendFailed || reader.status == AVAssetReaderStatusFailed ) {
        NSError *failure = writer.error ?: reader.error;
        [reader cancelReading];
        [writer cancelWriting];
        [[NSFileManager defaultManager] removeItemAtPath:outPath error:nil];
        if ( self->_cancelled ) {
          reject( @"CANCELLED", @"Cancelled", nil );
        } else {
          reject( @"RENDER_FAILED", failure.localizedDescription ?: @"Rendering failed", failure );
        }
        return;
      }
      [writer finishWritingWithCompletionHandler:^{
        if ( writer.status != AVAssetWriterStatusCompleted ) {
          reject( @"RENDER_FAILED", writer.error.localizedDescription ?: @"Could not finish the video", writer.error );
          return;
        }
        [self emitProgress:@"render" progress:1 force:YES];
        resolve( @{
          @"uri": [@"file://" stringByAppendingString:outPath],
          @"frames": @( index ),
        } );
      }];
    } );
  } );
}

// ─── Playback ────────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD( play : ( NSString * )path )
{
  dispatch_async( dispatch_get_main_queue( ), ^{
    AVPlayerViewController *controller = [[AVPlayerViewController alloc] init];
    controller.player = [AVPlayer playerWithURL:[NSURL fileURLWithPath:stripFileScheme( path )]];
    [RCTPresentedViewController( ) presentViewController:controller animated:YES completion:^{
      [controller.player play];
    }];
  } );
}

@end
