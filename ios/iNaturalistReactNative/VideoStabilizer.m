#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreImage/CoreImage.h>
#import <CoreLocation/CoreLocation.h>
#import <Photos/Photos.h>
#import <PhotosUI/PhotosUI.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTUtils.h>
#import <React/RCTViewManager.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// The measuring and rendering half of the video stabilizer; the camera-path
// math lives in JS (sharedHelpers/videoStabilization.ts).
//
//   pickVideo    copies a video from Photos into the working folder
//   probe        upright size, duration, frame rate
//   analyze      one pass over the frames, reporting per frame how each of
//                16 tiles moved since the previous frame and where it sits
//                on the first frame (phase correlation with Accelerate's FFT)
//   render       a second pass that warps each frame by the homography JS
//                computed for it, crops to the output size and writes an
//                H.264 .mov, passing the audio through untouched and keeping
//                the original's metadata (capture date, location, camera)
//   saveToPhotos adds a rendered video to the photo library with the
//                original's date and location
//
// Analyses and renders are numbered as they're asked for, and starting one
// cancels the one before, so JS can rerun them freely as settings change.
//
// Both passes read frames through the same AVAssetReaderVideoCompositionOutput
// (upright, constant frame rate, same time range), so frame i of the analysis
// is frame i of the render. All coordinates crossing the bridge are pixels of
// the upright full-size frame with the origin top-left; Core Image works
// bottom-left, and the conversions happen here.

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

// y ↦ height − y, its own inverse: converts between top-left and bottom-left.
static Mat3 mat3FlipY( double height )
{
  Mat3 r = { { 1, 0, 0, 0, -1, height, 0, 0, 1 } };
  return r;
}

static CGAffineTransform mat3AffinePart( Mat3 h )
{
  double w = fabs( h.m[8] ) > 1e-9 ? h.m[8] : 1;
  return CGAffineTransformMake( h.m[0] / w, h.m[3] / w, h.m[1] / w, h.m[4] / w, h.m[2] / w, h.m[5] / w );
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

static NSString *stripFileScheme( NSString *path )
{
  return [path hasPrefix:@"file://"] ? [path substringFromIndex:7] : path;
}

static NSString *workingDirectory( void )
{
  NSString *caches = NSSearchPathForDirectoriesInDomains( NSCachesDirectory, NSUserDomainMask, YES ).firstObject;
  return [caches stringByAppendingPathComponent:@"VideoStabilizer"];
}

// Removes files in the working folder whose names start with `prefix`, except
// `keep`.
static void removeWorkingFiles( NSString *prefix, NSString *keep )
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *dir = workingDirectory( );
  for ( NSString *name in [fm contentsOfDirectoryAtPath:dir error:nil] ) {
    NSString *path = [dir stringByAppendingPathComponent:name];
    if ( [name hasPrefix:prefix] && ![path isEqualToString:keep] ) {
      [fm removeItemAtPath:path error:nil];
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

// ─── Metadata ────────────────────────────────────────────────────────────────

// The original's file-level metadata, for the stabilized copy: capture date,
// location, camera make and model and the like. iPhone videos keep these as
// QuickTime metadata, which is copied as is; other cameras' common keys are
// carried over as their QuickTime equivalents.
static NSArray<AVMetadataItem *> *metadataToKeep( AVAsset *asset )
{
  NSMutableArray<AVMetadataItem *> *items = [NSMutableArray array];
  NSMutableSet<NSString *> *commonKeys = [NSMutableSet set];
  for ( AVMetadataFormat format in @[AVMetadataFormatQuickTimeMetadata, AVMetadataFormatQuickTimeUserData] ) {
    for ( AVMetadataItem *item in [asset metadataForFormat:format] ) {
      [items addObject:item];
      if ( item.commonKey ) [commonKeys addObject:item.commonKey];
    }
  }
  NSDictionary<AVMetadataKey, AVMetadataIdentifier> *quickTimeFor = @{
    AVMetadataCommonKeyCreationDate: AVMetadataIdentifierQuickTimeMetadataCreationDate,
    AVMetadataCommonKeyLocation: AVMetadataIdentifierQuickTimeMetadataLocationISO6709,
    AVMetadataCommonKeyMake: AVMetadataIdentifierQuickTimeMetadataMake,
    AVMetadataCommonKeyModel: AVMetadataIdentifierQuickTimeMetadataModel,
    AVMetadataCommonKeySoftware: AVMetadataIdentifierQuickTimeMetadataSoftware,
  };
  for ( AVMetadataItem *item in asset.commonMetadata ) {
    AVMetadataIdentifier identifier = item.commonKey ? quickTimeFor[item.commonKey] : nil;
    if ( !identifier || [commonKeys containsObject:item.commonKey] || !item.value ) continue;
    AVMutableMetadataItem *copy = [AVMutableMetadataItem metadataItem];
    copy.identifier = identifier;
    copy.value = item.value;
    copy.extendedLanguageTag = item.extendedLanguageTag;
    [items addObject:copy];
    [commonKeys addObject:item.commonKey];
  }
  return items;
}

static NSDate *metadataDate( AVAsset *asset )
{
  for ( AVMetadataItem *item in [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                                filteredByIdentifier:AVMetadataCommonIdentifierCreationDate] ) {
    if ( item.dateValue ) return item.dateValue;
    NSString *text = item.stringValue;
    if ( text.length == 0 ) continue;
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    NSDate *date = [formatter dateFromString:text];
    if ( date ) return date;
  }
  return nil;
}

// ISO 6709, as QuickTime stores it: "+37.3349-122.0090+010.000/".
static CLLocation *metadataLocation( AVAsset *asset )
{
  for ( AVMetadataItem *item in [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                                filteredByIdentifier:AVMetadataCommonIdentifierLocation] ) {
    NSString *text = item.stringValue;
    if ( text.length == 0 ) continue;
    NSRegularExpression *pattern = [NSRegularExpression
      regularExpressionWithPattern:@"^([+-][0-9.]+)([+-][0-9.]+)([+-][0-9.]+)?" options:0 error:nil];
    NSTextCheckingResult *match = [pattern firstMatchInString:text options:0 range:NSMakeRange( 0, text.length )];
    if ( !match ) continue;
    double latitude = [[text substringWithRange:[match rangeAtIndex:1]] doubleValue];
    double longitude = [[text substringWithRange:[match rangeAtIndex:2]] doubleValue];
    if ( fabs( latitude ) > 90 || fabs( longitude ) > 180 ) continue;
    NSRange altitudeRange = [match rangeAtIndex:3];
    double altitude = altitudeRange.location != NSNotFound
      ? [[text substringWithRange:altitudeRange] doubleValue]
      : 0;
    return [[CLLocation alloc] initWithCoordinate:CLLocationCoordinate2DMake( latitude, longitude )
                                         altitude:altitude
                               horizontalAccuracy:0
                                 verticalAccuracy:altitudeRange.location != NSNotFound ? 0 : -1
                                        timestamp:metadataDate( asset ) ?: [NSDate date]];
  }
  return nil;
}

@interface VideoStabilizer : RCTEventEmitter <RCTBridgeModule, PHPickerViewControllerDelegate>
@end

@implementation VideoStabilizer {
  RCTPromiseResolveBlock _pickResolve;
  RCTPromiseRejectBlock _pickReject;
  BOOL _hasListeners;
  // Bumped by every analysis, render and cancel; a job whose number is no
  // longer current stops at its next frame.
  volatile NSInteger _generation;
  // Analyses and renders, one at a time.
  dispatch_queue_t _queue;
  // Probing and frame grabs, so the start frame updates while an analysis
  // is still running.
  dispatch_queue_t _inspectQueue;
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
    _inspectQueue = dispatch_queue_create( "org.inaturalist.videostabilizer.inspect", DISPATCH_QUEUE_SERIAL );
    _ciContext = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
  }
  return self;
}

- (void)emitProgress:(NSString *)phase job:(id)job progress:(double)progress force:(BOOL)force
{
  CFAbsoluteTime now = CFAbsoluteTimeGetCurrent( );
  if ( !_hasListeners || ( !force && now - _lastProgressAt < 0.1 ) ) return;
  _lastProgressAt = now;
  [self sendEventWithName:kProgressEvent body:@{
    @"phase": phase,
    @"job": job ?: [NSNull null],
    @"progress": @( MAX( 0, MIN( 1, progress ) ) ),
  }];
}

- (BOOL)isCurrent:(NSInteger)generation
{
  return _generation == generation;
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
    // The system picker needs no Photos permission. "Current" hands over the
    // file as stored, metadata and all, instead of transcoding it first.
    PHPickerConfiguration *config = [[PHPickerConfiguration alloc] init];
    config.filter = [PHPickerFilter videosFilter];
    config.selectionLimit = 1;
    config.preferredAssetRepresentationMode = PHPickerConfigurationAssetRepresentationModeCurrent;
    PHPickerViewController *picker = [[PHPickerViewController alloc] initWithConfiguration:config];
    picker.delegate = self;
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

// ─── Inspection ──────────────────────────────────────────────────────────────

RCT_EXPORT_METHOD( probe
                  : ( NSString * )path resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _inspectQueue, ^{
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

RCT_EXPORT_METHOD( cancel )
{
  _generation += 1;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

// BEGIN FFT REGISTRATION (stabilization-eval/analyze.m compiles this block
// as is, so keep it free of the module's other code)
//
// Shifts are measured by phase correlation on a 4×4 grid of tiles of a
// grayscale copy of each frame, 960 px on its long side. Each tile reports
// its own shift and JS fits the camera path to all of them robustly, so tiles
// on a moving subject, or on something at another depth, drop out instead of
// dragging the estimate the way one registration of the whole frame does.
// Phase correlation gives sub-pixel shifts directly; Vision's registration
// reports whole pixels.

enum { kTileCols = 4, kTileRows = 4, kTileCount = kTileCols * kTileRows };
static const double kRegistrationDimension = 960;
// A tile counts only if this much of it lies inside the moved frame,
static const double kMinTileCover = 0.95;
// and its reference shows some texture (Laplacian standard deviation, in
// 0–255 gray levels): a flat sky or wall has no shift to find.
static const double kMinTileTexture = 1;
// Sensor and compression noise alone gives an out-of-focus background a
// Laplacian deviation of 2–3, which passes the test above, yet such a tile
// reports no motion or lags the camera. Structure is therefore also measured
// on the tile averaged over kStructureBlock × kStructureBlock pixels, where
// noise averages away and edges remain.
static const int kStructureBlock = 4;
static const double kMinTileStructure = 2;
// Each tile's phase-correlation shift is refined by up to this many
// Gauss-Newton (Lucas-Kanade) steps on the pixels themselves. Phase
// correlation whitens the spectrum, and a motion-blurred frame's spectrum
// changes sign, so on the blurred frames of a fast pan its peak splits and
// misses by pixels; the intensity fit doesn't.
static const int kRefineSteps = 10;
static const double kRefineMaxStep = 2;
static const double kRefineDone = 0.01;
static const int kMinTiles = 2;
// Peak height (0–1) a whole-frame fallback must reach to be believed.
static const float kFallbackResponse = 0.02f;
// A reading against the first frame further than this share of the frame
// from the chained estimate is a mismatch, not a correction.
static const double kMaxReadingJump = 0.2;

typedef struct {
  float *px;
  int width;
  int height;
} GrayImage;

static GrayImage grayImageCreate( int width, int height )
{
  GrayImage g = { calloc( (size_t)width * height, sizeof( float ) ), width, height };
  return g;
}

static void grayImageFree( GrayImage *g )
{
  free( g->px );
  g->px = NULL;
}

// Luma of a BGRA buffer of the image's size.
static void grayImageFill( GrayImage *g, CVPixelBufferRef bgra )
{
  CVPixelBufferLockBaseAddress( bgra, kCVPixelBufferLock_ReadOnly );
  const uint8_t *base = CVPixelBufferGetBaseAddress( bgra );
  size_t stride = CVPixelBufferGetBytesPerRow( bgra );
  for ( int y = 0; y < g->height; y++ ) {
    const uint8_t *row = base + y * stride;
    float *out = g->px + (size_t)y * g->width;
    for ( int x = 0; x < g->width; x++ ) {
      out[x] = 0.114f * row[4 * x] + 0.587f * row[4 * x + 1] + 0.299f * row[4 * x + 2];
    }
  }
  CVPixelBufferUnlockBaseAddress( bgra, kCVPixelBufferLock_ReadOnly );
}

// The longest length ≤ n that vDSP's DFT takes: f·2^k, f ∈ {1, 3, 5, 15}, k ≥ 3.
static int dftLength( int n )
{
  int best = 0;
  int factors[4] = { 1, 3, 5, 15 };
  for ( int i = 0; i < 4; i++ ) {
    for ( int length = factors[i] * 8; length <= n; length *= 2 ) {
      if ( length > best ) best = length;
    }
  }
  return best;
}

// Phase correlation of two width × height images: buffers and DFT setups,
// made once per size.
typedef struct {
  int width;
  int height;
  vDSP_DFT_Setup rowsForward;
  vDSP_DFT_Setup rowsInverse;
  vDSP_DFT_Setup columnsForward;
  vDSP_DFT_Setup columnsInverse;
  float *window;
  float *inRe, *inIm, *tmpRe, *tmpIm, *aRe, *aIm, *bRe, *bIm;
} PhaseCorrelator;

static void phaseCorrelatorFree( PhaseCorrelator *pc )
{
  if ( !pc ) return;
  if ( pc->rowsForward ) vDSP_DFT_DestroySetup( pc->rowsForward );
  if ( pc->rowsInverse ) vDSP_DFT_DestroySetup( pc->rowsInverse );
  if ( pc->columnsForward ) vDSP_DFT_DestroySetup( pc->columnsForward );
  if ( pc->columnsInverse ) vDSP_DFT_DestroySetup( pc->columnsInverse );
  float *buffers[9] = { pc->window, pc->inRe, pc->inIm, pc->tmpRe, pc->tmpIm, pc->aRe, pc->aIm, pc->bRe, pc->bIm };
  for ( int i = 0; i < 9; i++ ) free( buffers[i] );
  free( pc );
}

static PhaseCorrelator *phaseCorrelatorCreate( int width, int height )
{
  if ( width < 8 || height < 8 ) return NULL;
  PhaseCorrelator *pc = calloc( 1, sizeof( PhaseCorrelator ) );
  pc->width = width;
  pc->height = height;
  pc->rowsForward = vDSP_DFT_zop_CreateSetup( NULL, (vDSP_Length)width, vDSP_DFT_FORWARD );
  pc->rowsInverse = vDSP_DFT_zop_CreateSetup( pc->rowsForward, (vDSP_Length)width, vDSP_DFT_INVERSE );
  pc->columnsForward = vDSP_DFT_zop_CreateSetup( NULL, (vDSP_Length)height, vDSP_DFT_FORWARD );
  pc->columnsInverse = vDSP_DFT_zop_CreateSetup( pc->columnsForward, (vDSP_Length)height, vDSP_DFT_INVERSE );
  size_t n = (size_t)width * height;
  float **buffers[9] = {
    &pc->window, &pc->inRe, &pc->inIm, &pc->tmpRe, &pc->tmpIm, &pc->aRe, &pc->aIm, &pc->bRe, &pc->bIm,
  };
  for ( int i = 0; i < 9; i++ ) *buffers[i] = calloc( n, sizeof( float ) );
  if ( !pc->rowsForward || !pc->rowsInverse || !pc->columnsForward || !pc->columnsInverse ) {
    phaseCorrelatorFree( pc );
    return NULL;
  }
  // Hann window, the product of one along each axis.
  for ( int y = 0; y < height; y++ ) {
    double wy = 0.5 * ( 1 - cos( 2 * M_PI * y / ( height - 1 ) ) );
    for ( int x = 0; x < width; x++ ) {
      pc->window[(size_t)y * width + x] = (float)( wy * 0.5 * ( 1 - cos( 2 * M_PI * x / ( width - 1 ) ) ) );
    }
  }
  return pc;
}

// 2-D DFT of inRe/inIm (height rows of width) into outRe/outIm, which come
// out transposed (width rows of height); the inverse takes them that way and
// gives height rows of width back. tmp is scratch.
static void dft2d( PhaseCorrelator *pc, BOOL inverse, float *inRe, float *inIm, float *outRe, float *outIm )
{
  int w = pc->width;
  int h = pc->height;
  if ( !inverse ) {
    for ( int y = 0; y < h; y++ ) {
      vDSP_DFT_Execute( pc->rowsForward, inRe + y * w, inIm + y * w, pc->tmpRe + y * w, pc->tmpIm + y * w );
    }
    for ( int y = 0; y < h; y++ ) {
      for ( int x = 0; x < w; x++ ) {
        inRe[x * h + y] = pc->tmpRe[y * w + x];
        inIm[x * h + y] = pc->tmpIm[y * w + x];
      }
    }
    for ( int x = 0; x < w; x++ ) {
      vDSP_DFT_Execute( pc->columnsForward, inRe + x * h, inIm + x * h, outRe + x * h, outIm + x * h );
    }
  } else {
    for ( int x = 0; x < w; x++ ) {
      vDSP_DFT_Execute( pc->columnsInverse, inRe + x * h, inIm + x * h, pc->tmpRe + x * h, pc->tmpIm + x * h );
    }
    for ( int x = 0; x < w; x++ ) {
      for ( int y = 0; y < h; y++ ) {
        inRe[y * w + x] = pc->tmpRe[x * h + y];
        inIm[y * w + x] = pc->tmpIm[x * h + y];
      }
    }
    for ( int y = 0; y < h; y++ ) {
      vDSP_DFT_Execute( pc->rowsInverse, inRe + y * w, inIm + y * w, outRe + y * w, outIm + y * w );
    }
  }
}

// Copies a width × height window of `image` at (x0, y0), zero outside it,
// times the correlator's window, into inRe (inIm cleared).
static void loadWindowed( PhaseCorrelator *pc, const GrayImage *image, int x0, int y0 )
{
  int w = pc->width;
  int h = pc->height;
  for ( int y = 0; y < h; y++ ) {
    int sy = y0 + y;
    for ( int x = 0; x < w; x++ ) {
      int sx = x0 + x;
      float v = ( sx >= 0 && sy >= 0 && sx < image->width && sy < image->height )
        ? image->px[(size_t)sy * image->width + sx]
        : 0;
      pc->inRe[y * w + x] = v * pc->window[y * w + x];
      pc->inIm[y * w + x] = 0;
    }
  }
}

// The shift (dx, dy) that maps `targeted`'s window at (tx, ty) onto
// `reference`'s window at (rx, ry), top-left pixels, with the height of the
// correlation peak (1 for a perfect match).
static void phaseCorrelate(
  PhaseCorrelator *pc,
  const GrayImage *targeted, int tx, int ty,
  const GrayImage *reference, int rx, int ry,
  double *dx, double *dy, float *response
)
{
  int w = pc->width;
  int h = pc->height;
  size_t n = (size_t)w * h;
  loadWindowed( pc, reference, rx, ry );
  dft2d( pc, NO, pc->inRe, pc->inIm, pc->aRe, pc->aIm );
  loadWindowed( pc, targeted, tx, ty );
  dft2d( pc, NO, pc->inRe, pc->inIm, pc->bRe, pc->bIm );
  // Normalized cross-power spectrum, reference times the conjugate of targeted.
  for ( size_t k = 0; k < n; k++ ) {
    float re = pc->aRe[k] * pc->bRe[k] + pc->aIm[k] * pc->bIm[k];
    float im = pc->aIm[k] * pc->bRe[k] - pc->aRe[k] * pc->bIm[k];
    float mag = sqrtf( re * re + im * im ) + 1e-12f;
    pc->inRe[k] = re / mag;
    pc->inIm[k] = im / mag;
  }
  dft2d( pc, YES, pc->inRe, pc->inIm, pc->aRe, pc->aIm );
  // The peak sits at the shift, wrapped; a centroid over 5 × 5 around it
  // gives the fraction.
  const float *c = pc->aRe;
  size_t peak = 0;
  for ( size_t k = 1; k < n; k++ ) {
    if ( c[k] > c[peak] ) peak = k;
  }
  int px = (int)( peak % w );
  int py = (int)( peak / w );
  double sum = 0;
  double sumX = 0;
  double sumY = 0;
  for ( int oy = -2; oy <= 2; oy++ ) {
    for ( int ox = -2; ox <= 2; ox++ ) {
      double v = c[( ( py + oy + h ) % h ) * w + ( px + ox + w ) % w];
      sum += v;
      sumX += v * ox;
      sumY += v * oy;
    }
  }
  double x = px + ( sum > 0 ? sumX / sum : 0 );
  double y = py + ( sum > 0 ? sumY / sum : 0 );
  if ( x >= w / 2.0 ) x -= w;
  if ( y >= h / 2.0 ) y -= h;
  *dx = x;
  *dy = y;
  // The inverse DFT isn't scaled, so a perfect match peaks at n.
  *response = c[peak] / (float)n;
}

// Standard deviation of the Laplacian over the inside of a region.
static double textureOf( const GrayImage *g, int x0, int y0, int w, int h )
{
  double sum = 0;
  double sumSq = 0;
  int count = 0;
  for ( int y = y0 + 1; y < y0 + h - 1; y++ ) {
    const float *row = g->px + (size_t)y * g->width;
    for ( int x = x0 + 1; x < x0 + w - 1; x++ ) {
      double v = row[x - 1] + row[x + 1] + row[x - g->width] + row[x + g->width] - 4.0 * row[x];
      sum += v;
      sumSq += v * v;
      count += 1;
    }
  }
  if ( count == 0 ) return 0;
  double mean = sum / count;
  return sqrt( MAX( 0, sumSq / count - mean * mean ) );
}

// textureOf on the region averaged over kStructureBlock-pixel squares.
static double structureOf( const GrayImage *g, int x0, int y0, int w, int h )
{
  int k = kStructureBlock;
  int bw = w / k;
  int bh = h / k;
  if ( bw < 3 || bh < 3 ) return 0;
  GrayImage blocks = grayImageCreate( bw, bh );
  if ( !blocks.px ) return 0;
  for ( int by = 0; by < bh; by++ ) {
    for ( int bx = 0; bx < bw; bx++ ) {
      float sum = 0;
      for ( int y = 0; y < k; y++ ) {
        const float *row = g->px + (size_t)( y0 + by * k + y ) * g->width + x0 + bx * k;
        for ( int x = 0; x < k; x++ ) sum += row[x];
      }
      blocks.px[(size_t)by * bw + bx] = sum / ( k * k );
    }
  }
  double structure = textureOf( &blocks, 0, 0, bw, bh );
  grayImageFree( &blocks );
  return structure;
}

// Bilinear sample, clamped so the 2 × 2 neighbourhood stays in the image.
static inline float sampleBilinear( const GrayImage *g, double x, double y )
{
  int ix = (int)floor( x );
  int iy = (int)floor( y );
  float fx = (float)( x - ix );
  float fy = (float)( y - iy );
  ix = MIN( MAX( ix, 0 ), g->width - 2 );
  iy = MIN( MAX( iy, 0 ), g->height - 2 );
  const float *p = g->px + (size_t)iy * g->width + ix;
  return p[0] * ( 1 - fx ) * ( 1 - fy ) + p[1] * fx * ( 1 - fy )
    + p[g->width] * ( 1 - fx ) * fy + p[g->width + 1] * fx * fy;
}

// Refines (*sx, *sy), the shift that maps `targeted` onto `reference`, over
// the w × h window of `reference` at (x0, y0), weighted by `window`: Gauss-
// Newton on the intensity difference, each image's mean over the overlap
// removed. `scratch` holds (w + 2) × (h + 2) floats.
static void refineShift(
  const GrayImage *targeted, const GrayImage *reference,
  int x0, int y0, int w, int h, const float *window, float *scratch,
  double *sx, double *sy
)
{
  double x = *sx;
  double y = *sy;
  int sw = w + 2;
  for ( int step = 0; step < kRefineSteps; step++ ) {
    // targeted, moved by the shift, on the window's grid plus a 1-pixel rim
    // for the gradient; pixels whose rim leaves the frame don't count.
    for ( int j = -1; j <= h; j++ ) {
      for ( int i = -1; i <= w; i++ ) {
        scratch[( j + 1 ) * sw + i + 1] = sampleBilinear( targeted, x0 + i - x, y0 + j - y );
      }
    }
    double sumT = 0;
    double sumR = 0;
    int valid = 0;
    for ( int j = 0; j < h; j++ ) {
      double qy = y0 + j - y;
      if ( qy < 1 || qy >= targeted->height - 2 ) continue;
      for ( int i = 0; i < w; i++ ) {
        double qx = x0 + i - x;
        if ( qx < 1 || qx >= targeted->width - 2 ) continue;
        valid += 1;
        sumT += scratch[( j + 1 ) * sw + i + 1];
        sumR += reference->px[(size_t)( y0 + j ) * reference->width + x0 + i];
      }
    }
    if ( valid < w * h / 2 ) break;
    double meanT = sumT / valid;
    double meanR = sumR / valid;
    double a = 0;
    double b = 0;
    double c = 0;
    double ex = 0;
    double ey = 0;
    for ( int j = 0; j < h; j++ ) {
      double qy = y0 + j - y;
      if ( qy < 1 || qy >= targeted->height - 2 ) continue;
      const float *t = scratch + ( j + 1 ) * sw + 1;
      const float *r = reference->px + (size_t)( y0 + j ) * reference->width + x0;
      const float *win = window + (size_t)j * w;
      for ( int i = 0; i < w; i++ ) {
        double qx = x0 + i - x;
        if ( qx < 1 || qx >= targeted->width - 2 ) continue;
        double gx = 0.5 * ( t[i + 1] - t[i - 1] );
        double gy = 0.5 * ( t[i + sw] - t[i - sw] );
        double e = ( t[i] - meanT ) - ( r[i] - meanR );
        double v = win[i];
        a += v * gx * gx;
        b += v * gx * gy;
        c += v * gy * gy;
        ex += v * gx * e;
        ey += v * gy * e;
      }
    }
    a += 1e-6;
    c += 1e-6;
    double det = a * c - b * b;
    if ( !( fabs( det ) > 1e-12 ) ) break;
    // Moving the shift by d moves targeted's sample by −d, so the residual
    // changes by −grad · d.
    double dx = MIN( kRefineMaxStep, MAX( -kRefineMaxStep, ( c * ex - b * ey ) / det ) );
    double dy = MIN( kRefineMaxStep, MAX( -kRefineMaxStep, ( a * ey - b * ex ) / det ) );
    x += dx;
    y += dy;
    if ( hypot( dx, dy ) < kRefineDone ) break;
  }
  if ( isfinite( x ) && isfinite( y ) ) {
    *sx = x;
    *sy = y;
  }
}

typedef struct {
  int tileWidth;
  int tileHeight;
  PhaseCorrelator *tiles;
  PhaseCorrelator *whole;
  // refineShift's working rows, for a tile's correlated window.
  float *refineScratch;
} Registration;

static Registration registrationCreate( int width, int height )
{
  Registration r;
  r.tileWidth = ( width / kTileCols ) / 4 * 4;
  r.tileHeight = ( height / kTileRows ) / 4 * 4;
  r.tiles = phaseCorrelatorCreate( dftLength( r.tileWidth ), dftLength( r.tileHeight ) );
  r.whole = phaseCorrelatorCreate( dftLength( width ), dftLength( height ) );
  r.refineScratch = r.tiles
    ? calloc( (size_t)( r.tiles->width + 2 ) * ( r.tiles->height + 2 ), sizeof( float ) )
    : NULL;
  return r;
}

static void registrationFree( Registration *r )
{
  phaseCorrelatorFree( r->tiles );
  phaseCorrelatorFree( r->whole );
  free( r->refineScratch );
  r->tiles = NULL;
  r->whole = NULL;
  r->refineScratch = NULL;
}

// Every tile's shift from `targeted` onto `reference`, with `targeted` moved
// by the whole-pixel `move` first so that the tiles nearly line up. shifts
// gets (dx, dy) per tile, row by row from the top left, and found[k] says
// whether tile k counted. Returns how many did.
static int tileShifts(
  const Registration *r,
  const GrayImage *targeted,
  const GrayImage *reference,
  int moveX, int moveY,
  double shifts[][2],
  BOOL *found
)
{
  int count = 0;
  int tw = r->tileWidth;
  int th = r->tileHeight;
  for ( int k = 0; k < kTileCount; k++ ) found[k] = NO;
  if ( !r->tiles ) return 0;
  // The correlated window is the middle of the tile.
  int ox = ( tw - r->tiles->width ) / 2;
  int oy = ( th - r->tiles->height ) / 2;
  for ( int j = 0; j < kTileRows; j++ ) {
    for ( int i = 0; i < kTileCols; i++ ) {
      int x0 = i * tw;
      int y0 = j * th;
      if ( textureOf( reference, x0, y0, tw, th ) < kMinTileTexture ) continue;
      if ( structureOf( reference, x0, y0, tw, th ) < kMinTileStructure ) continue;
      // The part of the moved tile that comes from inside the frame.
      int sx0 = MAX( 0, x0 - moveX );
      int sy0 = MAX( 0, y0 - moveY );
      int sx1 = MIN( targeted->width, x0 - moveX + tw );
      int sy1 = MIN( targeted->height, y0 - moveY + th );
      double cover = ( sx1 > sx0 && sy1 > sy0 )
        ? (double)( sx1 - sx0 ) * ( sy1 - sy0 ) / ( (double)tw * th )
        : 0;
      if ( cover < kMinTileCover ) continue;
      double dx;
      double dy;
      float response;
      phaseCorrelate( r->tiles, targeted, x0 - moveX + ox, y0 - moveY + oy, reference, x0 + ox, y0 + oy,
        &dx, &dy, &response );
      dx += moveX;
      dy += moveY;
      if ( r->refineScratch ) {
        refineShift( targeted, reference, x0 + ox, y0 + oy, r->tiles->width, r->tiles->height,
          r->tiles->window, r->refineScratch, &dx, &dy );
      }
      int k = j * kTileCols + i;
      shifts[k][0] = dx;
      shifts[k][1] = dy;
      found[k] = YES;
      count += 1;
    }
  }
  return count;
}

static int compareDoubles( const void *a, const void *b )
{
  double x = *(const double *)a;
  double y = *(const double *)b;
  return ( x > y ) - ( x < y );
}

// Per-axis median of the tiles that counted; NO with fewer than kMinTiles.
static BOOL medianShift( double shifts[][2], const BOOL *found, double *mx, double *my )
{
  double xs[kTileCount];
  double ys[kTileCount];
  int n = 0;
  for ( int k = 0; k < kTileCount; k++ ) {
    if ( !found[k] ) continue;
    xs[n] = shifts[k][0];
    ys[n] = shifts[k][1];
    n += 1;
  }
  if ( n < kMinTiles ) return NO;
  qsort( xs, n, sizeof( double ), compareDoubles );
  qsort( ys, n, sizeof( double ), compareDoubles );
  *mx = n % 2 ? xs[n / 2] : ( xs[n / 2 - 1] + xs[n / 2] ) / 2;
  *my = n % 2 ? ys[n / 2] : ( ys[n / 2 - 1] + ys[n / 2] ) / 2;
  return YES;
}

// One frame's measurements. The running estimate (`chain`, the shift onto
// the first frame) only decides where the tiles are compared; JS fits the
// path from the tiles themselves.
typedef struct {
  double stepShifts[kTileCount][2];
  BOOL stepFound[kTileCount];
  double readingShifts[kTileCount][2];
  BOOL readingFound[kTileCount];
  double stepX, stepY;
  BOOL stepOK;
  BOOL readingOK;
} FrameMeasure;

typedef struct {
  Registration registration;
  GrayImage first;
  GrayImage previous;
  BOOL started;
  double chainX, chainY;
  double lastStepX, lastStepY;
} Tracker;

static Tracker trackerCreate( int width, int height )
{
  Tracker t;
  memset( &t, 0, sizeof( t ) );
  t.registration = registrationCreate( width, height );
  t.first = grayImageCreate( width, height );
  t.previous = grayImageCreate( width, height );
  return t;
}

static void trackerFree( Tracker *t )
{
  registrationFree( &t->registration );
  grayImageFree( &t->first );
  grayImageFree( &t->previous );
}

// Measures `current` (then remembers it as the previous frame). The first
// frame's readings are all zero.
static void trackerMeasure( Tracker *t, const GrayImage *current, FrameMeasure *m )
{
  memset( m, 0, sizeof( *m ) );
  size_t bytes = (size_t)current->width * current->height * sizeof( float );
  if ( !t->started ) {
    memcpy( t->first.px, current->px, bytes );
    memcpy( t->previous.px, current->px, bytes );
    t->started = YES;
    for ( int k = 0; k < kTileCount; k++ ) m->readingFound[k] = YES;
    m->stepOK = YES;
    m->readingOK = YES;
    return;
  }
  const Registration *r = &t->registration;
  // Onto the previous frame, moved by the last step: the camera rarely
  // changes speed much in a frame.
  tileShifts( r, current, &t->previous, (int)lround( t->lastStepX ), (int)lround( t->lastStepY ),
    m->stepShifts, m->stepFound );
  m->stepOK = medianShift( m->stepShifts, m->stepFound, &m->stepX, &m->stepY );
  if ( !m->stepOK && r->whole ) {
    double dx;
    double dy;
    float response;
    int ox = ( current->width - r->whole->width ) / 2;
    int oy = ( current->height - r->whole->height ) / 2;
    phaseCorrelate( r->whole, current, ox, oy, &t->previous, ox, oy, &dx, &dy, &response );
    if ( response > kFallbackResponse ) {
      m->stepX = dx;
      m->stepY = dy;
      m->stepOK = YES;
    }
  }
  if ( m->stepOK ) {
    t->chainX += m->stepX;
    t->chainY += m->stepY;
  }
  t->lastStepX = m->stepOK ? m->stepX : 0;
  t->lastStepY = m->stepOK ? m->stepY : 0;
  // Onto the first frame, moved by the chain so far.
  tileShifts( r, current, &t->first, (int)lround( t->chainX ), (int)lround( t->chainY ),
    m->readingShifts, m->readingFound );
  double rx;
  double ry;
  if ( medianShift( m->readingShifts, m->readingFound, &rx, &ry )
    && hypot( rx - t->chainX, ry - t->chainY ) < kMaxReadingJump * MAX( current->width, current->height ) ) {
    t->chainX = rx;
    t->chainY = ry;
    m->readingOK = YES;
  }
  memcpy( t->previous.px, current->px, bytes );
}

// END FFT REGISTRATION

// Tile shifts for the bridge: [dx, dy] per tile in full-frame pixels, or
// null where the tile didn't count.
static NSArray *tileArray( double shifts[][2], const BOOL *found, double toFull )
{
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:kTileCount];
  for ( int k = 0; k < kTileCount; k++ ) {
    [out addObject:found[k]
      ? @[@( shifts[k][0] * toFull ), @( shifts[k][1] * toFull )]
      : (id)[NSNull null]];
  }
  return out;
}

static NSArray<NSNumber *> *shiftArray( double x, double y )
{
  return @[@1, @0, @( x ), @0, @1, @( y ), @0, @0, @1];
}

RCT_EXPORT_METHOD( analyze
                  : ( NSString * )path options
                  : ( NSDictionary * )options resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSInteger generation = ++_generation;
  dispatch_async( _queue, ^{
    id job = options[@"job"];

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
    CVPixelBufferPoolRef pool = NULL;
    GrayImage gray = { NULL, 0, 0 };
    Tracker tracker;
    memset( &tracker, 0, sizeof( tracker ) );
    NSInteger refined = 0;
    size_t fullWidth = 0;
    size_t fullHeight = 0;
    double scale = 1;
    BOOL bufferFailed = NO;
    FrameMeasure *measure = calloc( 1, sizeof( FrameMeasure ) );

    while ( [self isCurrent:generation] ) {
      @autoreleasepool {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if ( !sample ) break;
        CVPixelBufferRef full = CMSampleBufferGetImageBuffer( sample );
        double t = CMTimeGetSeconds( CMSampleBufferGetPresentationTimeStamp( sample ) );
        if ( !pool ) {
          fullWidth = CVPixelBufferGetWidth( full );
          fullHeight = CVPixelBufferGetHeight( full );
          scale = MIN( 1, kRegistrationDimension / MAX( fullWidth, fullHeight ) );
          int width = (int)round( fullWidth * scale );
          int height = (int)round( fullHeight * scale );
          pool = makePixelBufferPool( (size_t)width, (size_t)height );
          gray = grayImageCreate( width, height );
          tracker = trackerCreate( width, height );
        }
        CVPixelBufferRef small = NULL;
        if ( pool ) CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &small );
        if ( !small || !gray.px ) {
          if ( small ) CVPixelBufferRelease( small );
          CFRelease( sample );
          bufferFailed = YES;
          break;
        }
        CIImage *fullImage = [CIImage imageWithCVPixelBuffer:full];
        [self->_ciContext render:[fullImage imageByApplyingTransform:CGAffineTransformMakeScale( scale, scale )]
                 toCVPixelBuffer:small];
        CFRelease( sample );
        grayImageFill( &gray, small );
        CVPixelBufferRelease( small );

        trackerMeasure( &tracker, &gray, measure );
        if ( measure->readingOK ) refined += 1;
        double toFull = 1 / scale;
        [frames addObject:@{
          @"t": @( t ),
          @"ok": @( measure->stepOK ),
          @"m": shiftArray( measure->stepX * toFull, measure->stepY * toFull ),
          @"r": shiftArray( tracker.chainX * toFull, tracker.chainY * toFull ),
          @"rok": @( measure->readingOK ),
          @"ts": tileArray( measure->stepShifts, measure->stepFound, toFull ),
          @"tr": tileArray( measure->readingShifts, measure->readingFound, toFull ),
        }];
        [self emitProgress:@"analyze" job:job progress:( t - CMTimeGetSeconds( range.start ) ) / rangeSeconds force:NO];
      }
    }
    free( measure );
    trackerFree( &tracker );
    grayImageFree( &gray );
    if ( pool ) CVPixelBufferPoolRelease( pool );

    if ( ![self isCurrent:generation] ) {
      [reader cancelReading];
      reject( @"CANCELLED", @"Cancelled", nil );
      return;
    }
    if ( bufferFailed ) [reader cancelReading];
    if ( bufferFailed || reader.status == AVAssetReaderStatusFailed || frames.count == 0 ) {
      reject( @"ANALYZE_FAILED", reader.error.localizedDescription ?: @"No frames could be read", reader.error );
      return;
    }

    [self emitProgress:@"analyze" job:job progress:1 force:YES];
    resolve( @{
      @"width": @( fullWidth ),
      @"height": @( fullHeight ),
      @"fps": @( frameRateOf( [asset tracksWithMediaType:AVMediaTypeVideo].firstObject ) ),
      @"frames": frames,
      @"tileCols": @( kTileCols ),
      @"tileRows": @( kTileRows ),
      // How many frames could be measured against the first frame.
      @"refinedFrames": @( refined ),
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
  NSInteger generation = ++_generation;
  dispatch_async( _queue, ^{
    id job = options[@"job"];
    NSArray<NSNumber *> *flat = options[@"transforms"];
    NSInteger outWidth = [options[@"outputWidth"] integerValue];
    NSInteger outHeight = [options[@"outputHeight"] integerValue];
    NSString *prefix = [options[@"preview"] boolValue] ? @"preview-" : @"stabilized-";
    NSInteger transformCount = (NSInteger)flat.count / 9;
    if ( transformCount == 0 || outWidth < 2 || outHeight < 2 ) {
      reject( @"RENDER_FAILED", @"Nothing to render", nil );
      return;
    }
    double *transforms = malloc( sizeof( double ) * transformCount * 9 );
    for ( NSInteger i = 0; i < transformCount * 9; i++ ) transforms[i] = flat[i].doubleValue;

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

    NSString *outPath = [workingDirectory( ) stringByAppendingPathComponent:
      [NSString stringWithFormat:@"%@%@.mov", prefix, [NSUUID UUID].UUIDString]];
    AVAssetWriter *writer = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:outPath]
                                                     fileType:AVFileTypeQuickTimeMovie error:&error];
    if ( !writer ) {
      free( transforms );
      reject( @"RENDER_FAILED", error.localizedDescription, error );
      return;
    }
    writer.metadata = metadataToKeep( asset );
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
    if ( audioTrack ) {
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
          CMSampleBufferRef sample = [self isCurrent:generation] ? [videoOutput copyNextSampleBuffer] : NULL;
          if ( !sample ) {
            videoDone = YES;
            [videoInput markAsFinished];
            dispatch_group_leave( group );
            break;
          }
          CVPixelBufferRef source = CMSampleBufferGetImageBuffer( sample );
          CMTime pts = CMSampleBufferGetPresentationTimeStamp( sample );
          Mat3 topLeft;
          memcpy( topLeft.m, transforms + MIN( index, transformCount - 1 ) * 9, sizeof( topLeft.m ) );
          // JS's homography is top-left source pixels → top-left output
          // pixels; Core Image needs it between the two bottom-left spaces.
          Mat3 warp = mat3Mul( mat3FlipY( outHeight ),
            mat3Mul( topLeft, mat3FlipY( CVPixelBufferGetHeight( source ) ) ) );
          CIImage *frame = [warpImage( [CIImage imageWithCVPixelBuffer:source], warp )
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
                         job:job
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
          CMSampleBufferRef sample = ( ![self isCurrent:generation] || appendFailed )
            ? NULL
            : [audioOutput copyNextSampleBuffer];
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
      BOOL cancelled = ![self isCurrent:generation];
      if ( cancelled || appendFailed || reader.status == AVAssetReaderStatusFailed ) {
        NSError *failure = writer.error ?: reader.error;
        [reader cancelReading];
        [writer cancelWriting];
        [[NSFileManager defaultManager] removeItemAtPath:outPath error:nil];
        if ( cancelled ) {
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
        // Only now is the last finished file replaced, so whatever is
        // playing it keeps playing until there's something newer.
        removeWorkingFiles( prefix, outPath );
        [self emitProgress:@"render" job:job progress:1 force:YES];
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

// ─── Saving ──────────────────────────────────────────────────────────────────

// Adds `path` to the photo library dated and placed like `original`, the
// imported video; the date is moved on by `start`, where the stabilized copy
// begins. Photos would otherwise date it when it was saved, with no place.
RCT_EXPORT_METHOD( saveToPhotos
                  : ( NSString * )path original
                  : ( NSString * )original start
                  : ( double )start resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly handler:^( PHAuthorizationStatus status ) {
    if ( status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited ) {
      reject( @"SAVE_DENIED", @"Allow the app to add to your photo library in Settings to save the video.", nil );
      return;
    }
    AVURLAsset *source = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( original )] options:nil];
    NSDate *date = metadataDate( source );
    CLLocation *location = metadataLocation( source );
    NSURL *url = [NSURL fileURLWithPath:stripFileScheme( path )];
    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      PHAssetCreationRequest *request = [PHAssetCreationRequest creationRequestForAsset];
      [request addResourceWithType:PHAssetResourceTypeVideo fileURL:url options:nil];
      if ( date ) request.creationDate = [date dateByAddingTimeInterval:MAX( 0, start )];
      if ( location ) request.location = location;
    } completionHandler:^( BOOL success, NSError *error ) {
      if ( success ) {
        resolve( nil );
      } else {
        reject( @"SAVE_FAILED", error.localizedDescription ?: @"Could not save the video", error );
      }
    }];
  }];
}

@end

// ─── Comparison player ───────────────────────────────────────────────────────

// The original (from the start time) above the stabilized preview, as one
// composition with both tracks stacked. One player clock drives
// both, so they stay frame for frame in step, including across the loop.
static AVPlayerItem *comparisonItem( NSString *originalPath, NSString *stabilizedPath, double start )
{
  AVURLAsset *original = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( originalPath )]
                                             options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
  AVURLAsset *stabilized = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stripFileScheme( stabilizedPath )]
                                               options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
  AVAssetTrack *originalTrack = [original tracksWithMediaType:AVMediaTypeVideo].firstObject;
  AVAssetTrack *stabilizedTrack = [stabilized tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if ( !originalTrack || !stabilizedTrack ) return nil;

  // The stabilized frame i is the original frame i after `start`.
  CMTimeRange stabilizedRange = stabilizedTrack.timeRange;
  CMTime originalStart = CMTimeMakeWithSeconds( MAX( 0, start ), 600 );
  CMTime originalLeft = CMTimeSubtract( CMTimeRangeGetEnd( originalTrack.timeRange ), originalStart );
  CMTime duration = CMTimeMinimum( stabilizedRange.duration, originalLeft );
  if ( CMTimeCompare( duration, kCMTimeZero ) <= 0 ) return nil;

  AVMutableComposition *composition = [AVMutableComposition composition];
  AVMutableCompositionTrack *top = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                                             preferredTrackID:kCMPersistentTrackID_Invalid];
  AVMutableCompositionTrack *bottom = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                                              preferredTrackID:kCMPersistentTrackID_Invalid];
  if ( ![top insertTimeRange:CMTimeRangeMake( originalStart, duration ) ofTrack:originalTrack
                       atTime:kCMTimeZero error:nil]
    || ![bottom insertTimeRange:CMTimeRangeMake( stabilizedRange.start, duration ) ofTrack:stabilizedTrack
                        atTime:kCMTimeZero error:nil] ) {
    return nil;
  }

  // Each half is the stabilized preview's size; the original is turned
  // upright and scaled to fit it.
  CGRect stabilizedRect = CGRectApplyAffineTransform(
    CGRectMake( 0, 0, stabilizedTrack.naturalSize.width, stabilizedTrack.naturalSize.height ),
    stabilizedTrack.preferredTransform );
  CGSize cell = CGSizeMake( round( fabs( stabilizedRect.size.width ) ), round( fabs( stabilizedRect.size.height ) ) );
  CGRect originalRect = CGRectApplyAffineTransform(
    CGRectMake( 0, 0, originalTrack.naturalSize.width, originalTrack.naturalSize.height ),
    originalTrack.preferredTransform );
  CGFloat scale = MIN( cell.width / originalRect.size.width, cell.height / originalRect.size.height );
  CGAffineTransform originalTransform = originalTrack.preferredTransform;
  originalTransform = CGAffineTransformConcat( originalTransform,
    CGAffineTransformMakeTranslation( -originalRect.origin.x, -originalRect.origin.y ) );
  originalTransform = CGAffineTransformConcat( originalTransform, CGAffineTransformMakeScale( scale, scale ) );
  originalTransform = CGAffineTransformConcat( originalTransform, CGAffineTransformMakeTranslation(
    ( cell.width - originalRect.size.width * scale ) / 2,
    ( cell.height - originalRect.size.height * scale ) / 2 ) );
  CGAffineTransform stabilizedTransform = stabilizedTrack.preferredTransform;
  stabilizedTransform = CGAffineTransformConcat( stabilizedTransform,
    CGAffineTransformMakeTranslation( -stabilizedRect.origin.x, cell.height - stabilizedRect.origin.y ) );

  AVMutableVideoCompositionLayerInstruction *topLayer =
    [AVMutableVideoCompositionLayerInstruction videoCompositionLayerInstructionWithAssetTrack:top];
  [topLayer setTransform:originalTransform atTime:kCMTimeZero];
  AVMutableVideoCompositionLayerInstruction *bottomLayer =
    [AVMutableVideoCompositionLayerInstruction videoCompositionLayerInstructionWithAssetTrack:bottom];
  [bottomLayer setTransform:stabilizedTransform atTime:kCMTimeZero];
  AVMutableVideoCompositionInstruction *instruction = [AVMutableVideoCompositionInstruction videoCompositionInstruction];
  instruction.timeRange = CMTimeRangeMake( kCMTimeZero, duration );
  instruction.layerInstructions = @[topLayer, bottomLayer];
  instruction.backgroundColor = [UIColor blackColor].CGColor;

  AVMutableVideoComposition *videoComposition = [AVMutableVideoComposition videoComposition];
  videoComposition.instructions = @[instruction];
  videoComposition.renderSize = CGSizeMake( cell.width, cell.height * 2 );
  videoComposition.frameDuration = CMTimeMake( 1000, (int32_t)round( frameRateOf( stabilizedTrack ) * 1000 ) );

  AVPlayerItem *item = [AVPlayerItem playerItemWithAsset:composition];
  item.videoComposition = videoComposition;
  return item;
}

// Loops the comparison silently, and pauses while off screen.
@interface VideoStabilizerComparisonView : UIView
@property ( nonatomic, copy ) NSString *original;
@property ( nonatomic, copy ) NSString *stabilized;
@property ( nonatomic, assign ) double start;
@end

@implementation VideoStabilizerComparisonView {
  AVQueuePlayer *_player;
  AVPlayerLooper *_looper;
  AVPlayerLayer *_layer;
  NSString *_loadedKey;
  BOOL _reloadScheduled;
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if ( ( self = [super initWithFrame:frame] ) ) {
    self.backgroundColor = [UIColor blackColor];
    _player = [[AVQueuePlayer alloc] init];
    _player.muted = YES;
    _layer = [AVPlayerLayer playerLayerWithPlayer:_player];
    _layer.videoGravity = AVLayerVideoGravityResizeAspect;
    [self.layer addSublayer:_layer];
  }
  return self;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _layer.frame = self.bounds;
}

- (void)setOriginal:(NSString *)original { _original = [original copy]; [self scheduleReload]; }
- (void)setStabilized:(NSString *)stabilized { _stabilized = [stabilized copy]; [self scheduleReload]; }
- (void)setStart:(double)start { _start = start; [self scheduleReload]; }

// The props arrive one at a time; build once they've all been set.
- (void)scheduleReload
{
  if ( _reloadScheduled ) return;
  _reloadScheduled = YES;
  dispatch_async( dispatch_get_main_queue( ), ^{
    self->_reloadScheduled = NO;
    [self reload];
  } );
}

- (void)reload
{
  NSString *key = [NSString stringWithFormat:@"%@|%@|%f", _original ?: @"", _stabilized ?: @"", _start];
  if ( [key isEqualToString:_loadedKey] ) return;
  _loadedKey = key;
  [_looper disableLooping];
  _looper = nil;
  [_player removeAllItems];
  if ( _original.length == 0 || _stabilized.length == 0 ) return;
  NSString *original = _original;
  NSString *stabilized = _stabilized;
  double start = _start;
  // Reading the tracks can block, so the item is built off the main thread.
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_USER_INITIATED, 0 ), ^{
    AVPlayerItem *item = comparisonItem( original, stabilized, start );
    dispatch_async( dispatch_get_main_queue( ), ^{
      if ( !item || ![key isEqualToString:self->_loadedKey] ) return;
      self->_looper = [AVPlayerLooper playerLooperWithPlayer:self->_player templateItem:item];
      if ( self.window ) [self->_player play];
    } );
  } );
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if ( self.window ) {
    if ( _looper ) [_player play];
  } else {
    [_player pause];
  }
}

- (void)dealloc
{
  [_player pause];
  [_looper disableLooping];
}

@end

@interface VideoStabilizerComparisonManager : RCTViewManager
@end

@implementation VideoStabilizerComparisonManager

RCT_EXPORT_MODULE( )

RCT_EXPORT_VIEW_PROPERTY( original, NSString )
RCT_EXPORT_VIEW_PROPERTY( stabilized, NSString )
RCT_EXPORT_VIEW_PROPERTY( start, double )

- (UIView *)view { return [VideoStabilizerComparisonView new]; }

@end
