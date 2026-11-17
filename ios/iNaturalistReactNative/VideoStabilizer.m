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
#import <Vision/Vision.h>

// The measuring and rendering half of the video stabilizer; the camera-path
// math lives in JS (sharedHelpers/videoStabilization.ts).
//
//   pickVideo    copies a video from Photos into the working folder
//   probe        upright size, duration, frame rate
//   frameAt      a JPEG of one frame, for choosing the crop
//   analyze      one pass over the frames, reporting per frame how the
//                picture moved since the previous frame (Vision image
//                registration) and, for a complete lock, where it sits on the
//                first frame; for rolling-shutter correction, also how the
//                top and bottom of the picture moved, each on its own, from
//                which JS works out the sensor's readout time
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

RCT_EXPORT_METHOD( frameAt
                  : ( NSString * )path seconds
                  : ( double )seconds maxDimension
                  : ( double )maxDimension resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _inspectQueue, ^{
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
    removeWorkingFiles( @"frame-", nil );
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
  _generation += 1;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

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

RCT_EXPORT_METHOD( analyze
                  : ( NSString * )path options
                  : ( NSDictionary * )options resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSInteger generation = ++_generation;
  dispatch_async( _queue, ^{
    // A complete lock also measures every frame against the first, so the
    // small errors of chaining frame to frame don't add up to a drift.
    BOOL reference = [options[@"reference"] boolValue];
    // Rolling shutter: register the top and bottom of each frame separately.
    // Their rows are read at different times, so when the camera speeds up or
    // slows down they move by different amounts, and how different measures
    // the readout. The difference is a pixel or two, so the strips are
    // registered at twice the detail of the whole frame.
    BOOL strips = [options[@"strips"] boolValue];
    double stripMaxDimension = 960;
    double stripFraction = 0.4;
    id job = options[@"job"];
    // Registration needs little detail.
    double maxDimension = 480;

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

    NSMutableArray<NSMutableDictionary *> *frames = [NSMutableArray array];
    NSMutableArray<NSValue *> *steps = [NSMutableArray array];  // Mat3 per frame, onto the previous
    NSMutableArray<NSValue *> *toFirst = [NSMutableArray array];  // Mat3 per frame, onto the first
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
    BOOL bufferFailed = NO;
    CVPixelBufferPoolRef stripPool = NULL;
    CVPixelBufferRef previousTop = NULL;
    CVPixelBufferRef previousBottom = NULL;
    double stripScale = 1;
    double stripFullHeight = 0;
    NSMutableDictionary<NSNumber *, NSArray *> *stripSteps = [NSMutableDictionary dictionary];

    while ( [self isCurrent:generation] ) {
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
          if ( strips ) {
            stripScale = MIN( 1, stripMaxDimension / MAX( fullWidth, fullHeight ) );
            stripFullHeight = round( fullHeight * stripFraction );
            stripPool = makePixelBufferPool(
              (size_t)round( fullWidth * stripScale ),
              (size_t)round( stripFullHeight * stripScale )
            );
          }
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
        // Core Image is bottom-left: the top strip is the highest rows.
        CVPixelBufferRef top = NULL;
        CVPixelBufferRef bottom = NULL;
        if ( stripPool ) {
          CVPixelBufferPoolCreatePixelBuffer( NULL, stripPool, &top );
          CVPixelBufferPoolCreatePixelBuffer( NULL, stripPool, &bottom );
          double origins[2] = { fullHeight - stripFullHeight, 0 };
          CVPixelBufferRef targets[2] = { top, bottom };
          for ( int k = 0; k < 2; k++ ) {
            if ( !targets[k] ) continue;
            CGRect rect = CGRectMake( 0, origins[k], fullWidth, stripFullHeight );
            CGAffineTransform place = CGAffineTransformConcat(
              CGAffineTransformMakeTranslation( 0, -origins[k] ),
              CGAffineTransformMakeScale( stripScale, stripScale )
            );
            [self->_ciContext render:[[fullImage imageByCroppingToRect:rect] imageByApplyingTransform:place]
                     toCVPixelBuffer:targets[k]];
          }
        }
        CFRelease( sample );

        NSMutableDictionary *frame = [@{ @"t": @( t ), @"ok": @YES } mutableCopy];
        Mat3 step = mat3Identity( );
        if ( previous && !registerImages( small, previous, &step ) ) {
          step = mat3Identity( );
          frame[@"ok"] = @NO;
        }
        [steps addObject:[NSValue valueWithBytes:&step objCType:@encode( Mat3 )]];

        if ( top && bottom && previousTop && previousBottom ) {
          Mat3 topStep;
          Mat3 bottomStep;
          if ( registerImages( top, previousTop, &topStep ) && registerImages( bottom, previousBottom, &bottomStep ) ) {
            stripSteps[@( frames.count )] = @[
              [NSValue valueWithBytes:&topStep objCType:@encode( Mat3 )],
              [NSValue valueWithBytes:&bottomStep objCType:@encode( Mat3 )],
            ];
          }
        }
        if ( previousTop ) CVPixelBufferRelease( previousTop );
        if ( previousBottom ) CVPixelBufferRelease( previousBottom );
        previousTop = top;
        previousBottom = bottom;

        if ( reference ) {
          if ( !first ) {
            first = CVPixelBufferRetain( small );
          } else {
            chain = mat3Mul( chain, step );
            // What's left after lining the frame up by the chained estimate is
            // small, so registering that against the first frame is reliable
            // even where the two frames are far apart.
            CVPixelBufferRef warped = NULL;
            CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &warped );
            if ( warped ) {
              CIImage *aligned = [warpImage( [CIImage imageWithCVPixelBuffer:small], chain )
                imageByCompositingOverImage:blackSmall];
              [self->_ciContext render:[aligned imageByCroppingToRect:blackSmall.extent] toCVPixelBuffer:warped];
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
        }

        if ( previous ) CVPixelBufferRelease( previous );
        previous = small;
        [frames addObject:frame];
        [self emitProgress:@"analyze" job:job progress:( t - CMTimeGetSeconds( range.start ) ) / rangeSeconds force:NO];
      }
    }
    if ( previous ) CVPixelBufferRelease( previous );
    if ( first ) CVPixelBufferRelease( first );
    if ( pool ) CVPixelBufferPoolRelease( pool );
    if ( previousTop ) CVPixelBufferRelease( previousTop );
    if ( previousBottom ) CVPixelBufferRelease( previousBottom );
    if ( stripPool ) CVPixelBufferPoolRelease( stripPool );

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

    // Bottom-left pixels of the small frame → top-left pixels of the full one.
    Mat3 toTopLeft = mat3Mul( mat3Scale( 1 / scale ), mat3FlipY( smallHeight ) );
    Mat3 fromTopLeft = mat3Inv( toTopLeft );
    for ( NSUInteger i = 0; i < frames.count; i++ ) {
      Mat3 step;
      [steps[i] getValue:&step];
      frames[i][@"m"] = mat3Array( mat3Mul( toTopLeft, mat3Mul( i == 0 ? mat3Identity( ) : step, fromTopLeft ) ) );
      if ( reference ) {
        Mat3 r;
        [toFirst[i] getValue:&r];
        frames[i][@"r"] = mat3Array( mat3Mul( toTopLeft, mat3Mul( r, fromTopLeft ) ) );
      }
    }
    // The strips' steps, likewise in top-left pixels of the full frame. They
    // are pure shifts, so which strip they came from doesn't change this.
    Mat3 stripToTopLeft = mat3Mul( mat3Scale( 1 / stripScale ), mat3FlipY( stripFullHeight * stripScale ) );
    Mat3 stripFromTopLeft = mat3Inv( stripToTopLeft );
    for ( NSNumber *index in stripSteps ) {
      Mat3 topStep;
      Mat3 bottomStep;
      [stripSteps[index][0] getValue:&topStep];
      [stripSteps[index][1] getValue:&bottomStep];
      frames[index.unsignedIntegerValue][@"mt"] = mat3Array( mat3Mul( stripToTopLeft, mat3Mul( topStep, stripFromTopLeft ) ) );
      frames[index.unsignedIntegerValue][@"mb"] = mat3Array( mat3Mul( stripToTopLeft, mat3Mul( bottomStep, stripFromTopLeft ) ) );
    }

    [self emitProgress:@"analyze" job:job progress:1 force:YES];
    NSMutableDictionary *result = [@{
      @"width": @( fullWidth ),
      @"height": @( fullHeight ),
      @"fps": @( frameRateOf( [asset tracksWithMediaType:AVMediaTypeVideo].firstObject ) ),
      @"frames": frames,
      // How many frames the lock against the first frame could refine.
      @"refinedFrames": @( refined ),
    } mutableCopy];
    if ( strips && fullHeight > 0 ) {
      // Where the strips' middles sit, in frame heights from the frame's middle.
      double half = stripFullHeight / 2 / fullHeight;
      result[@"strips"] = @{ @"top": @( half - 0.5 ), @"bottom": @( 0.5 - half ) };
    }
    resolve( result );
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
