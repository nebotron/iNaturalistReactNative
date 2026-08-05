#import <AVFoundation/AVFoundation.h>
#import <CoreLocation/CoreLocation.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>
#include <stdlib.h>
#include "onnxruntime_c_api.h"

@interface ImageCropper : NSObject <RCTBridgeModule, PHPhotoLibraryChangeObserver>
@end

// Forward-declared so methods defined earlier in this file (updateAssetLocation)
// can call these helpers, which are implemented further down near
// deletePhotoAssets.
@interface ImageCropper ()
- ( UIWindow * )inatKeyWindow;
- ( NSString * )inatPresentedVCChain:( UIWindow * )window;
@end

// A dismissal's completion block runs before UIKit has finished tearing the
// presentation down, and iOS won't present its Photos confirmation over a
// window it still considers busy — which leaves performChanges' completion
// handler hanging with no dialog on screen, the failure mode this whole file
// keeps chasing. Give the window a beat to settle before asking Photos for a
// transaction. DevicePhotoCleanup.tsx already does this on the JS side for the
// sheet it dismisses itself; this covers the modals dismissed down here.
static const NSTimeInterval kInatDismissalSettleSeconds = 0.35;

static void inatAfterDismissalSettles( void ( ^work )( void ) )
{
  dispatch_after(
    dispatch_time( DISPATCH_TIME_NOW,
      ( int64_t )( kInatDismissalSettleSeconds * NSEC_PER_SEC ) ),
    dispatch_get_main_queue(),
    work );
}

// A deletion whose completion handler never fires — the wedge this file keeps
// chasing — used to leave the change observer registered and the requested
// identifiers pending for the life of the process. Every later library change
// then ran a main-queue fetch for a batch JS had abandoned two minutes
// earlier, and a change much later still could resolve that dead promise.
// Anything held until a PhotoKit completion handler fires needs releasing on a
// timer as well; comfortably past JS's 120s timeout, so the observer fallback
// below keeps its full window.
static const NSTimeInterval kInatPendingDeleteWatchdogSeconds = 150;

@implementation ImageCropper {
  // Tracks the single in-flight deletePhotoAssets call (JS serializes calls
  // through one chain, so at most one is ever pending) so
  // photoLibraryDidChange: can tell whether it's watching for anything.
  NSArray<NSString *> *_pendingDeleteIds;
  NSUInteger _pendingDeleteRequestedCount;
  RCTPromiseResolveBlock _pendingDeleteResolve;
  BOOL _pendingDeleteSettled;
  // Bumped per deletion so a watchdog can tell its own call from the one that
  // replaced it.
  NSUInteger _pendingDeleteGeneration;
}

RCT_EXPORT_MODULE( );

// ─── Orientation helpers ────────────────────────────────────────────────────

static CGImagePropertyOrientation orientationFromUIImage( UIImage *image )
{
  switch ( image.imageOrientation ) {
    case UIImageOrientationUp:            return kCGImagePropertyOrientationUp;
    case UIImageOrientationDown:          return kCGImagePropertyOrientationDown;
    case UIImageOrientationLeft:          return kCGImagePropertyOrientationLeft;
    case UIImageOrientationRight:         return kCGImagePropertyOrientationRight;
    case UIImageOrientationUpMirrored:    return kCGImagePropertyOrientationUpMirrored;
    case UIImageOrientationDownMirrored:  return kCGImagePropertyOrientationDownMirrored;
    case UIImageOrientationLeftMirrored:  return kCGImagePropertyOrientationLeftMirrored;
    case UIImageOrientationRightMirrored: return kCGImagePropertyOrientationRightMirrored;
    default:                              return kCGImagePropertyOrientationUp;
  }
}

// ─── Vision helpers (saliency fallback) ─────────────────────────────────────

static NSDictionary *normalizedBoundsFromVisionRect( CGRect rect )
{
  if ( rect.size.width <= 0 || rect.size.height <= 0 ) return nil;
  return @{
    @"x":      @( rect.origin.x ),
    @"y":      @( 1.0 - rect.origin.y - rect.size.height ),
    @"width":  @( rect.size.width ),
    @"height": @( rect.size.height ),
  };
}

static CGRect unionVisionRect( CGRect existing, CGRect next, BOOL hasExisting )
{
  if ( !hasExisting ) return next;
  CGFloat minX = MIN( existing.origin.x, next.origin.x );
  CGFloat minY = MIN( existing.origin.y, next.origin.y );
  CGFloat maxX = MAX( existing.origin.x + existing.size.width,  next.origin.x + next.size.width );
  CGFloat maxY = MAX( existing.origin.y + existing.size.height, next.origin.y + next.size.height );
  return CGRectMake( minX, minY, maxX - minX, maxY - minY );
}

// Attention-based saliency — used only when YOLO finds no subject
static NSDictionary *detectSubjectBoundsSaliency( VNImageRequestHandler *handler )
{
  VNGenerateAttentionBasedSaliencyImageRequest *req =
    [[VNGenerateAttentionBasedSaliencyImageRequest alloc] init];
  NSError *error = nil;
  if ( ![handler performRequests:@[req] error:&error] ) return nil;

  CGRect unionRect = CGRectZero;
  BOOL   hasUnion  = NO;
  for ( VNSaliencyImageObservation *obs in req.results ) {
    for ( VNRectangleObservation *salientObj in obs.salientObjects ) {
      unionRect = unionVisionRect( unionRect, salientObj.boundingBox, hasUnion );
      hasUnion  = YES;
    }
  }
  return hasUnion ? normalizedBoundsFromVisionRect( unionRect ) : nil;
}

// ─── YOLO / ONNX Runtime detection ──────────────────────────────────────────

#define YOLO_INPUT_SIZE  640
#define YOLO_CONF_THRESH 0.05f   // raw scores from YOLO-World INT8 are pre-sigmoid; 0.05 separates noise from detections
#define YOLO_IOU_THRESH  0.45f
// If the best post-NMS box is below this threshold the detection is likely spurious;
// returning nil triggers the Vision attention-saliency fallback instead.
#define YOLO_GATE_CONF   0.25f
// Union: include box if its confidence is at least this fraction of the best box.
// Cap at this many boxes to prevent noisy low-conf detections from bloating the union.
#define YOLO_UNION_THRESH 0.60f
#define YOLO_UNION_MAX_K  3

typedef struct { float x1, y1, x2, y2, conf; } YOLOBox;

static OrtEnv     *s_ortEnv     = NULL;
static OrtSession *s_ortSession = NULL;
static BOOL        s_yoloFailed = NO;
// The current model also exposes a "brightness" output (a ridge head baked
// into the graph — see scripts/bake_brightness_head.py). Detected at init so
// an older single-output model file keeps working.
static BOOL        s_hasBrightnessOutput = NO;

static void initYOLOSession( void )
{
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    NSString *path = [[NSBundle mainBundle] pathForResource:@"yolov8n" ofType:@"onnx"];
    if ( !path ) { s_yoloFailed = YES; return; }

    const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );

    if ( ort->CreateEnv( ORT_LOGGING_LEVEL_WARNING, "iNat", &s_ortEnv ) ) {
      s_yoloFailed = YES; return;
    }

    OrtSessionOptions *opts;
    if ( ort->CreateSessionOptions( &opts ) ) { s_yoloFailed = YES; return; }
    ort->SetIntraOpNumThreads( opts, 2 );
    ort->SetInterOpNumThreads( opts, 1 );

    OrtStatus *status = ort->CreateSession( s_ortEnv, [path UTF8String], opts, &s_ortSession );
    ort->ReleaseSessionOptions( opts );
    if ( status ) { ort->ReleaseStatus( status ); s_yoloFailed = YES; return; }

    size_t outputCount = 0;
    if ( !ort->SessionGetOutputCount( s_ortSession, &outputCount ) ) {
      s_hasBrightnessOutput = outputCount >= 2;
    }
  } );
}

// Returns a [3 × N × N] float32 tensor (CHW, normalized 0-1) from a letterboxed image.
static float *preprocessForYOLO( UIImage *image,
                                  float *outPadLeft, float *outPadTop, float *outScale )
{
  const int N  = YOLO_INPUT_SIZE;
  float     iW = (float)image.size.width;
  float     iH = (float)image.size.height;
  float     s  = MIN( (float)N / iW, (float)N / iH );
  float     nW = iW * s, nH = iH * s;
  float     pL = ( N - nW ) / 2.0f;
  float     pT = ( N - nH ) / 2.0f;

  *outScale   = s;
  *outPadLeft = pL;
  *outPadTop  = pT;

  // Draw letterboxed image onto a gray 640×640 canvas
  UIGraphicsBeginImageContextWithOptions( CGSizeMake( N, N ), YES, 1.0 );
  CGContextRef gc = UIGraphicsGetCurrentContext();
  CGContextSetFillColorWithColor( gc, [UIColor colorWithWhite:127.0 / 255.0 alpha:1.0].CGColor );
  CGContextFillRect( gc, CGRectMake( 0, 0, N, N ) );
  [image drawInRect:CGRectMake( pL, pT, nW, nH )];
  UIImage *lb = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  // Render into RGBA byte buffer
  CGColorSpaceRef cs  = CGColorSpaceCreateDeviceRGB();
  unsigned char  *raw = (unsigned char *)calloc( (size_t)N * N * 4, 1 );
  CGContextRef    bmp = CGBitmapContextCreate(
    raw, N, N, 8, (size_t)4 * N, cs,
    kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast );
  CGContextDrawImage( bmp, CGRectMake( 0, 0, N, N ), lb.CGImage );
  CGContextRelease( bmp );
  CGColorSpaceRelease( cs );

  // RGBA → normalized float32 CHW
  int     plane  = N * N;
  float  *tensor = (float *)malloc( (size_t)3 * plane * sizeof( float ) );
  for ( int i = 0; i < plane; i++ ) {
    tensor[0 * plane + i] = raw[i * 4 + 0] / 255.0f;
    tensor[1 * plane + i] = raw[i * 4 + 1] / 255.0f;
    tensor[2 * plane + i] = raw[i * 4 + 2] / 255.0f;
  }
  free( raw );
  return tensor;
}

static float boxIOU( YOLOBox a, YOLOBox b )
{
  float ix1 = MAX( a.x1, b.x1 ), iy1 = MAX( a.y1, b.y1 );
  float ix2 = MIN( a.x2, b.x2 ), iy2 = MIN( a.y2, b.y2 );
  if ( ix2 <= ix1 || iy2 <= iy1 ) return 0.0f;
  float inter = ( ix2 - ix1 ) * ( iy2 - iy1 );
  float ua    = ( a.x2 - a.x1 ) * ( a.y2 - a.y1 )
              + ( b.x2 - b.x1 ) * ( b.y2 - b.y1 ) - inter;
  return ua > 0.0f ? inter / ua : 0.0f;
}

static int compareBoxByConf( const void *a, const void *b )
{
  float ca = ( (const YOLOBox *)a )->conf;
  float cb = ( (const YOLOBox *)b )->conf;
  return ( cb > ca ) ? 1 : ( cb < ca ) ? -1 : 0;
}

// Returns {x,y,width,height} in top-left normalised coords, or nil if nothing detected.
// When the model carries the baked-in brightness head, *outBrightness receives the
// predicted exposure multiplier (already clamped in-graph) even if no box passes the
// gate; it is left untouched otherwise.
static NSDictionary *detectSubjectBoundsYOLO( UIImage *image, float *outBrightness )
{
  initYOLOSession();
  if ( s_yoloFailed || !s_ortSession ) return nil;

  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  const int     N   = YOLO_INPUT_SIZE;

  float padLeft, padTop, scale;
  float *inputData = preprocessForYOLO( image, &padLeft, &padTop, &scale );

  OrtMemoryInfo *memInfo;
  ort->CreateCpuMemoryInfo( OrtArenaAllocator, OrtMemTypeDefault, &memInfo );

  int64_t   inputShape[] = { 1, 3, N, N };
  OrtValue *inputTensor  = NULL;
  OrtStatus *status = ort->CreateTensorWithDataAsOrtValue(
    memInfo, inputData, (size_t)3 * N * N * sizeof( float ),
    inputShape, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &inputTensor );
  ort->ReleaseMemoryInfo( memInfo );

  if ( status || !inputTensor ) {
    if ( status ) ort->ReleaseStatus( status );
    free( inputData );
    return nil;
  }

  const char *inputNames[]  = { "images" };
  const char *outputNames[] = { "output0", "brightness" };
  size_t      numOutputs    = s_hasBrightnessOutput ? 2 : 1;
  OrtValue   *outputs[2]    = { NULL, NULL };

  status = ort->Run( s_ortSession, NULL,
                     inputNames,  (const OrtValue *const *)&inputTensor,  1,
                     outputNames, numOutputs, outputs );
  ort->ReleaseValue( inputTensor );
  free( inputData );

  if ( status || !outputs[0] ) {
    if ( status ) ort->ReleaseStatus( status );
    if ( outputs[1] ) ort->ReleaseValue( outputs[1] );
    return nil;
  }

  if ( outputs[1] && outBrightness ) {
    float *bright = NULL;
    if ( !ort->GetTensorMutableData( outputs[1], (void **)&bright ) && bright ) {
      *outBrightness = bright[0];
    }
  }
  if ( outputs[1] ) ort->ReleaseValue( outputs[1] );
  OrtValue *outputTensor = outputs[0];

  // output0: [1, 5, 8400] — rows 0-3 = cx,cy,w,h; row 4 = objectness score (1 class)
  float *out;
  ort->GetTensorMutableData( outputTensor, (void **)&out );

  const int numPreds  = 8400;

  YOLOBox *dets  = (YOLOBox *)malloc( (size_t)numPreds * sizeof( YOLOBox ) );
  int      nDets = 0;

  for ( int j = 0; j < numPreds; j++ ) {
    float maxScore = out[4 * numPreds + j];
    if ( maxScore < YOLO_CONF_THRESH ) continue;

    float cx = out[0 * numPreds + j];
    float cy = out[1 * numPreds + j];
    float bw = out[2 * numPreds + j];
    float bh = out[3 * numPreds + j];
    dets[nDets++] = (YOLOBox){ cx - bw / 2.0f, cy - bh / 2.0f,
                                cx + bw / 2.0f, cy + bh / 2.0f, maxScore };
  }
  ort->ReleaseValue( outputTensor );

  if ( nDets == 0 ) { free( dets ); return nil; }

  // Greedy NMS — then union kept boxes with conf ≥ 50% of the best box's conf.
  // Filtering low-confidence outliers avoids an over-large union when a few
  // spurious detections fall on the background.
  qsort( dets, (size_t)nDets, sizeof( YOLOBox ), compareBoxByConf );
  BOOL *suppressed = (BOOL *)calloc( (size_t)nDets, sizeof( BOOL ) );

  // First pass: NMS to get the kept set and the best (first) box confidence.
  float bestConf = -1.0f;
  int   kept     = 0;
  for ( int i = 0; i < nDets; i++ ) {
    if ( suppressed[i] ) continue;
    if ( bestConf < 0.0f ) bestConf = dets[i].conf;
    kept++;
    for ( int k = i + 1; k < nDets; k++ ) {
      if ( !suppressed[k] && boxIOU( dets[i], dets[k] ) > YOLO_IOU_THRESH )
        suppressed[k] = YES;
    }
  }

  if ( kept == 0 ) { free( dets ); free( suppressed ); return nil; }

  // Gate: if the strongest detection is still weak, the model is uncertain — fall
  // back to Vision attention saliency rather than crop to a likely-wrong location.
  if ( bestConf < YOLO_GATE_CONF ) { free( dets ); free( suppressed ); return nil; }

  // Second pass: union top-K boxes at ≥ YOLO_UNION_THRESH of best confidence.
  float confThreshold = YOLO_UNION_THRESH * bestConf;
  float uX1 = FLT_MAX, uY1 = FLT_MAX, uX2 = -FLT_MAX, uY2 = -FLT_MAX;
  int   used = 0;
  for ( int i = 0; i < nDets; i++ ) {
    if ( suppressed[i] )                   continue;
    if ( dets[i].conf < confThreshold )    continue;
    if ( used >= YOLO_UNION_MAX_K )        break;
    uX1 = MIN( uX1, dets[i].x1 );
    uY1 = MIN( uY1, dets[i].y1 );
    uX2 = MAX( uX2, dets[i].x2 );
    uY2 = MAX( uY2, dets[i].y2 );
    used++;
  }
  if ( used == 0 ) {  // fallback: use best box
    uX1 = dets[0].x1; uY1 = dets[0].y1;
    uX2 = dets[0].x2; uY2 = dets[0].y2;
  }
  free( dets );
  free( suppressed );

  // Map 640×640 box back to original normalised image coordinates
  float imgW = (float)image.size.width;
  float imgH = (float)image.size.height;

  float x = ( uX1 - padLeft ) / scale / imgW;
  float y = ( uY1 - padTop  ) / scale / imgH;
  float w = ( uX2 - uX1     ) / scale / imgW;
  float h = ( uY2 - uY1     ) / scale / imgH;

  x = MAX( 0.0f, MIN( 1.0f, x ) );
  y = MAX( 0.0f, MIN( 1.0f, y ) );
  w = MAX( 0.01f, MIN( 1.0f - x, w ) );
  h = MAX( 0.01f, MIN( 1.0f - y, h ) );

  return @{ @"x": @(x), @"y": @(y), @"width": @(w), @"height": @(h) };
}

// ─── Brightness measurement ──────────────────────────────────────────────────

static int compareFloatsAsc( const void *a, const void *b )
{
  float fa = *(const float *)a, fb = *(const float *)b;
  return ( fa > fb ) - ( fa < fb );
}

// Samples a 64×64 pixel grid within normCrop (0-1 coords) and returns the
// geometric-mean and median perceptual luminance [0,1] of the region via the
// out params. Pass CGRectMake(0,0,1,1) for the full image. Returns NO on
// failure. Definitions must stay in sync with
// scripts/compute_brightness_crop_features.py (geomean clips luminance at
// 1e-4 before the log; median averages the two middle samples).
static BOOL measureCropLuminance( UIImage *image, CGRect normCrop,
                                  float *outGeomean, float *outMedian )
{
  const int N  = 64;
  float imgW   = (float)image.size.width;
  float imgH   = (float)image.size.height;

  // Scale the full image so the crop region fills the N×N canvas.
  float scaleX = N / ( normCrop.size.width  * imgW );
  float scaleY = N / ( normCrop.size.height * imgH );
  float drawW  = imgW * scaleX;
  float drawH  = imgH * scaleY;
  float drawX  = -normCrop.origin.x * imgW * scaleX;
  float drawY  = -normCrop.origin.y * imgH * scaleY;

  UIGraphicsBeginImageContextWithOptions( CGSizeMake( N, N ), YES, 1.0 );
  [image drawInRect:CGRectMake( drawX, drawY, drawW, drawH )];
  UIImage *scaled = UIGraphicsGetImageFromCurrentImageContext( );
  UIGraphicsEndImageContext( );

  if ( !scaled.CGImage ) return NO;

  CGColorSpaceRef cs  = CGColorSpaceCreateDeviceRGB( );
  unsigned char  *raw = (unsigned char *)calloc( (size_t)N * N * 4, 1 );
  CGContextRef    bmp = CGBitmapContextCreate(
    raw, N, N, 8, (size_t)4 * N, cs,
    kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast );
  CGContextDrawImage( bmp, CGRectMake( 0, 0, N, N ), scaled.CGImage );
  CGContextRelease( bmp );
  CGColorSpaceRelease( cs );

  float *lums = (float *)malloc( (size_t)N * N * sizeof( float ) );
  double logSum = 0.0;
  for ( int i = 0; i < N * N; i++ ) {
    float r = raw[i * 4 + 0] / 255.0f;
    float g = raw[i * 4 + 1] / 255.0f;
    float b = raw[i * 4 + 2] / 255.0f;
    lums[i] = 0.299f * r + 0.587f * g + 0.114f * b;
    logSum += log( fmax( lums[i], 1e-4f ) );
  }
  free( raw );
  qsort( lums, N * N, sizeof( float ), compareFloatsAsc );
  *outGeomean = (float)exp( logSum / ( N * N ) );
  *outMedian  = 0.5f * ( lums[N * N / 2 - 1] + lums[N * N / 2] );
  free( lums );
  return YES;
}

// ─── Brightness adjustment (linear multiply) ─────────────────────────────────

// Brightness: multiplies each channel's encoded value by the gain k and clamps
// to [0, 255], the same operation the CSS brightness() filter applies to the
// live slider preview — so the baked result matches what the slider showed. The
// gain is identical for every pixel, so precompute the 256 possible outputs
// once and apply them with a single table lookup per channel.
static void applyBrightnessMultiplyBuffer( unsigned char *raw, int pixelCount, float k )
{
  unsigned char lut[256];
  for ( int i = 0; i < 256; i++ ) {
    float v = roundf( i * k );
    lut[i] = v <= 0.0f ? 0 : ( v >= 255.0f ? 255 : (unsigned char)v );
  }

  for ( int i = 0; i < pixelCount; i++ ) {
    unsigned char *px = raw + i * 4;
    px[0] = lut[px[0]];
    px[1] = lut[px[1]];
    px[2] = lut[px[2]];
  }
}

// ─── Public detection entry point ────────────────────────────────────────────

// Try YOLO; fall back to Vision attention saliency when nothing is detected.
// The model's brightness prediction (computed on the same forward pass) is
// attached to whichever bounds are returned.
static NSDictionary *detectSubjectBoundsForImage( UIImage *image )
{
  if ( image.CGImage == NULL ) return nil;

  float brightness = -1.0f;
  NSDictionary *bounds = detectSubjectBoundsYOLO( image, &brightness );

  if ( !bounds ) {
    CGImagePropertyOrientation orientation = orientationFromUIImage( image );
    VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage
                                         orientation:orientation
                                             options:@{}];
    bounds = detectSubjectBoundsSaliency( handler );
  }

  if ( bounds && brightness > 0.0f ) {
    NSMutableDictionary *withBrightness = [bounds mutableCopy];
    withBrightness[@"brightness"] = @( brightness );
    bounds = withBrightness;
  }
  return bounds;
}

// ─── Image metadata helpers ──────────────────────────────────────────────────

static void updateMetadataForCrop( NSMutableDictionary *metadata, NSInteger width, NSInteger height )
{
  metadata[(NSString *)kCGImagePropertyPixelWidth]  = @( width );
  metadata[(NSString *)kCGImagePropertyPixelHeight] = @( height );
  metadata[(NSString *)kCGImagePropertyOrientation] = @( 1 );

  NSString            *exifKey = (__bridge NSString *)kCGImagePropertyExifDictionary;
  NSMutableDictionary *exif    = [[metadata[exifKey] mutableCopy] ?: @{} mutableCopy];
  exif[(NSString *)kCGImagePropertyExifPixelXDimension] = @( width );
  exif[(NSString *)kCGImagePropertyExifPixelYDimension] = @( height );
  metadata[exifKey] = exif;

  NSString            *tiffKey = (__bridge NSString *)kCGImagePropertyTIFFDictionary;
  NSMutableDictionary *tiff    = [[metadata[tiffKey] mutableCopy] ?: @{} mutableCopy];
  tiff[@"ImageWidth"]                                      = @( width );
  tiff[@"ImageLength"]                                     = @( height );
  tiff[(NSString *)kCGImagePropertyTIFFOrientation]        = @( 1 );
  metadata[tiffKey] = tiff;
}

static NSData *jpegDataFromCroppedImage(
  CGImageRef       croppedRef,
  NSDictionary    *sourceMetadata,
  NSInteger        width,
  NSInteger        height
)
{
  NSMutableDictionary *metadata = sourceMetadata
    ? [sourceMetadata mutableCopy]
    : [NSMutableDictionary dictionary];
  updateMetadataForCrop( metadata, width, height );
  metadata[(NSString *)kCGImageDestinationLossyCompressionQuality] = @( 1.0 );

  NSMutableData      *destinationData = [NSMutableData data];
  CGImageDestinationRef destination   = CGImageDestinationCreateWithData(
    (__bridge CFMutableDataRef)destinationData, CFSTR( "public.jpeg" ), 1, nil );
  if ( destination == NULL ) return nil;

  CGImageDestinationAddImage( destination, croppedRef, (__bridge CFDictionaryRef)metadata );
  BOOL finalized = CGImageDestinationFinalize( destination );
  CFRelease( destination );
  return finalized ? destinationData : nil;
}

// ─── Exported React Native methods ───────────────────────────────────────────

RCT_EXPORT_METHOD( cropImage
                  : ( NSString * )inputPath originX
                  : ( nonnull NSNumber * )originX originY
                  : ( nonnull NSNumber * )originY width
                  : ( nonnull NSNumber * )width height
                  : ( nonnull NSNumber * )height outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input  = [inputPath  stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString *output = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSURL    *inputURL    = [NSURL fileURLWithPath:input];
  CGImageSourceRef src  = CGImageSourceCreateWithURL( (__bridge CFURLRef)inputURL, nil );
  NSDictionary *srcMeta = nil;
  if ( src ) {
    srcMeta = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex( src, 0, nil );
    CFRelease( src );
  }

  UIImage *image = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { reject( @"CROP_FAILED", @"Could not load image", nil ); return; }

  CGRect     cropRect   = CGRectMake( [originX integerValue], [originY integerValue],
                                      [width integerValue],   [height integerValue] );
  CGImageRef croppedRef = NULL;

  if ( image.imageOrientation == UIImageOrientationUp ) {
    croppedRef = CGImageCreateWithImageInRect( image.CGImage, cropRect );
  } else {
    // The crop rect is in the display (EXIF-oriented) coordinate space, but
    // image.CGImage is stored in the raw sensor orientation, so cropping it
    // directly would take the wrong region. Rather than redraw the entire
    // full-resolution image just to normalize orientation and then crop out a
    // small region — a large transient allocation on every image — draw only
    // the crop-sized region: drawInRect applies the orientation, and offsetting
    // the full image by -origin lands the wanted region in the small context.
    // Integer offsets at 1:1 scale, so the pixels match a full redraw + crop.
    UIGraphicsBeginImageContextWithOptions( cropRect.size, NO, 1.0 );
    [image drawInRect:CGRectMake( -cropRect.origin.x, -cropRect.origin.y,
                                  image.size.width, image.size.height )];
    UIImage *croppedImage = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    if ( croppedImage.CGImage ) croppedRef = CGImageRetain( croppedImage.CGImage );
  }
  if ( !croppedRef ) { reject( @"CROP_FAILED", @"Crop failed", nil ); return; }

  NSData *data = jpegDataFromCroppedImage( croppedRef,
                                           srcMeta,
                                           [width integerValue],
                                           [height integerValue] );
  CGImageRelease( croppedRef );
  if ( !data ) { reject( @"CROP_FAILED", @"Could not encode cropped image", nil ); return; }

  [[NSFileManager defaultManager]
    createDirectoryAtPath:[output stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];
  if ( ![data writeToFile:output atomically:YES] ) {
    reject( @"CROP_FAILED", @"Could not write cropped image", nil ); return;
  }
  resolve( output );
}

RCT_EXPORT_METHOD( preserveImageMetadata
                  : ( NSString * )sourcePath destPath
                  : ( NSString * )destPath width
                  : ( nonnull NSNumber * )width height
                  : ( nonnull NSNumber * )height resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *source  = [sourcePath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString *dest    = [destPath   stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSURL    *srcURL  = [NSURL fileURLWithPath:source];
  CGImageSourceRef src = CGImageSourceCreateWithURL( (__bridge CFURLRef)srcURL, nil );
  NSDictionary *srcMeta = nil;
  if ( src ) {
    srcMeta = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex( src, 0, nil );
    CFRelease( src );
  }

  UIImage *croppedImage = [UIImage imageWithContentsOfFile:dest];
  if ( !croppedImage ) { reject( @"CROP_FAILED", @"Could not load cropped image", nil ); return; }
  CGImageRef croppedRef = croppedImage.CGImage;
  if ( !croppedRef )    { reject( @"CROP_FAILED", @"Could not read cropped image", nil ); return; }

  NSData *data = jpegDataFromCroppedImage( croppedRef, srcMeta,
                                           [width integerValue], [height integerValue] );
  if ( !data ) { reject( @"CROP_FAILED", @"Could not encode cropped image with metadata", nil ); return; }
  if ( ![data writeToFile:dest atomically:YES] ) {
    reject( @"CROP_FAILED", @"Could not write cropped image", nil ); return;
  }
  resolve( dest );
}

// Exports a PHAsset to a local file using PHAssetResourceManager, which writes
// the original file bytes verbatim — preserving all EXIF metadata (GPS,
// timestamp, camera make/model, etc.) without re-encoding.
RCT_EXPORT_METHOD( exportPHAsset
                  : ( NSString * )phUri destPath
                  : ( NSString * )destPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *localIdentifier = [phUri hasPrefix:@"ph://"]
    ? [phUri substringFromIndex:5]
    : phUri;

  PHFetchResult<PHAsset *> *result =
    [PHAsset fetchAssetsWithLocalIdentifiers:@[localIdentifier] options:nil];
  PHAsset *asset = result.firstObject;
  if ( !asset ) {
    reject( @"EXPORT_FAILED", @"PHAsset not found", nil );
    return;
  }

  PHAssetResource *photoResource = nil;
  for ( PHAssetResource *r in [PHAssetResource assetResourcesForAsset:asset] ) {
    if ( r.type == PHAssetResourceTypePhoto ) {
      photoResource = r;
      break;
    }
  }
  if ( !photoResource ) {
    reject( @"EXPORT_FAILED", @"No photo resource found for asset", nil );
    return;
  }

  NSString *dest = [destPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  [[NSFileManager defaultManager]
    createDirectoryAtPath:[dest stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];

  PHAssetResourceRequestOptions *options = [[PHAssetResourceRequestOptions alloc] init];
  options.networkAccessAllowed = YES;

  // An offloaded (iCloud-optimized) asset over a weak connection can fail the
  // iCloud fetch rather than just being slow, surfacing as the opaque
  // "PHPhotosErrorDomain error -1" — retry with backoff instead of failing
  // the import on the first hiccup, giving the download time to complete.
  static const NSInteger maxAttempts = 5;
  NSArray<NSNumber *> *retryDelaySeconds = @[@2, @4, @8, @16];

  // writeDataForAssetResource can also simply never call back: the app log
  // shows imports that logged "Done tapped" and no "settled" line at all, then
  // a relaunch — one wedged asset leaves Promise.all pending forever, so the
  // whole import hangs with a frozen progress bar until the user kills the app.
  // There is no way to cancel the request, so stop waiting on it instead:
  // networkAccessAllowed downloads report progress, and an export that has made
  // none for this long is wedged rather than slow. A download that is merely
  // slow keeps ticking and is left alone however long it takes.
  static const NSTimeInterval stallTimeoutSeconds = 60;
  static const NSTimeInterval stallCheckSeconds = 5;
  __block BOOL settled = NO;
  __block double lastProgress = 0;
  __block NSTimeInterval lastProgressAt = [NSDate timeIntervalSinceReferenceDate];
  options.progressHandler = ^( double progress ) {
    lastProgress = progress;
    lastProgressAt = [NSDate timeIntervalSinceReferenceDate];
  };

  __block void ( ^attemptExport )( NSInteger );
  attemptExport = ^( NSInteger attemptNumber ) {
    lastProgressAt = [NSDate timeIntervalSinceReferenceDate];
    // writeDataForAssetResource refuses to write to a path that already
    // exists, and reports that refusal as the same opaque "PHPhotosErrorDomain
    // error -1" a failed iCloud fetch gives. A first attempt that fails partway
    // leaves its partial file behind, so every retry after it was failing on
    // the leftover rather than retrying the download — which is why the app log
    // held 158 export failures and not one "Exported after N attempt(s)".
    [[NSFileManager defaultManager] removeItemAtPath:dest error:nil];
    [[PHAssetResourceManager defaultManager]
      writeDataForAssetResource:photoResource
      toFile:[NSURL fileURLWithPath:dest]
      options:options
      completionHandler:^( NSError *error ) {
        dispatch_async( dispatch_get_main_queue(), ^{
          // A write we already gave up on can still call back later; it must
          // not resolve a promise that was rejected, nor start a retry that
          // would race a live write over the same destination path.
          if ( settled ) { return; }
          if ( !error ) {
            settled = YES;
            resolve( @{
              @"uri": [NSString stringWithFormat:@"file://%@", dest],
              @"attempts": @( attemptNumber + 1 ),
            } );
            attemptExport = nil;
            return;
          }
          if ( attemptNumber + 1 >= maxAttempts ) {
            // localizedDescription for these is always the same opaque sentence,
            // so carry the domain and code that identify which failure it was.
            NSString *message = [NSString stringWithFormat:@"%@ [%@ %ld] (after %ld attempt(s))",
              error.localizedDescription, error.domain, ( long )error.code,
              ( long )( attemptNumber + 1 )];
            settled = YES;
            reject( @"EXPORT_FAILED", message, error );
            attemptExport = nil;
            return;
          }
          NSTimeInterval delay = retryDelaySeconds[attemptNumber].doubleValue;
          dispatch_after(
            dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( delay * NSEC_PER_SEC ) ),
            dispatch_get_main_queue(),
            ^{ if ( !settled ) { attemptExport( attemptNumber + 1 ); } }
          );
        } );
      }];
  };

  __block void ( ^watchForStall )( void );
  // watchForStall and the __block slot holding it retain each other, so the
  // slot has to be cleared to break the cycle — but never from inside the block
  // itself, which would free the running block (and the reject block it
  // captures) mid-call. Hop to the next main-queue turn instead.
  void ( ^releaseWatch )( void ) = ^{
    dispatch_async( dispatch_get_main_queue(), ^{ watchForStall = nil; } );
  };
  watchForStall = ^{
    if ( settled ) { releaseWatch( ); return; }
    NSTimeInterval idleFor = [NSDate timeIntervalSinceReferenceDate] - lastProgressAt;
    if ( idleFor >= stallTimeoutSeconds ) {
      settled = YES;
      attemptExport = nil;
      // A stable marker so the app log can count these separately from the
      // iCloud fetch failures that do come back with an error.
      reject( @"EXPORT_STALLED",
        [NSString stringWithFormat:@"export_stalled: no progress for %.0fs (progress=%.2f)",
          idleFor, lastProgress],
        nil );
      releaseWatch( );
      return;
    }
    dispatch_after(
      dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( stallCheckSeconds * NSEC_PER_SEC ) ),
      dispatch_get_main_queue(),
      ^{ if ( watchForStall ) { watchForStall( ); } }
    );
  };

  attemptExport( 0 );
  dispatch_after(
    dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( stallCheckSeconds * NSEC_PER_SEC ) ),
    dispatch_get_main_queue(),
    ^{ watchForStall( ); }
  );
}

// Updates the location metadata of an existing Photos-library asset. Unlike
// exportPHAsset, this mutates the user's actual Photos library (not just an
// app-local copy), so tracked-location corrections show up in the Photos app.
// Only fills in location for assets that are missing it: if the asset already
// carries a location we leave it untouched (resolving @NO) rather than
// overwriting the photo's own GPS metadata.
//
// Like deletePhotoAssets, this can trigger a system confirmation the first
// time an app modifies an asset it doesn't own - and iOS silently refuses to
// present that confirmation over an already-presented modal, leaving
// performChanges' completion handler (and this promise) hanging forever. See
// inatPresentedVCChain / deletePhotoAssets for the diagnosed root cause;
// dismiss any presented modal first so the confirmation has somewhere to go.
RCT_EXPORT_METHOD( updateAssetLocation
                  : ( NSString * )phUri latitude
                  : ( nonnull NSNumber * )latitude longitude
                  : ( nonnull NSNumber * )longitude resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSString *localIdentifier = [phUri hasPrefix:@"ph://"]
      ? [phUri substringFromIndex:5]
      : phUri;

    PHFetchResult<PHAsset *> *result =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[localIdentifier] options:nil];
    PHAsset *asset = result.firstObject;
    if ( !asset ) {
      reject( @"UPDATE_LOCATION_FAILED", @"PHAsset not found", nil );
      return;
    }

    if ( asset.location != nil ) {
      resolve( @NO );
      return;
    }

    CLLocation *location = [[CLLocation alloc] initWithLatitude:[latitude doubleValue]
                                                       longitude:[longitude doubleValue]];

    void ( ^doUpdate )( void ) = ^{
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        PHAssetChangeRequest *changeRequest = [PHAssetChangeRequest changeRequestForAsset:asset];
        changeRequest.location = location;
      } completionHandler:^( BOOL success, NSError *error ) {
        if ( success ) {
          resolve( @YES );
        } else {
          reject( @"UPDATE_LOCATION_FAILED", error.localizedDescription, error );
        }
      }];
    };

    UIWindow *keyWindow = [self inatKeyWindow];
    UIViewController *root = keyWindow.rootViewController;
    if ( root.presentedViewController ) {
      [root dismissViewControllerAnimated:NO completion:^{
        inatAfterDismissalSettles( doUpdate );
      }];
    } else {
      doUpdate();
    }
  } );
}

// Applies location to many assets in a single PHPhotoLibrary transaction.
// One performChanges means one system confirmation instead of one per photo:
// a group-photo import fired a separate transaction for every photo missing
// GPS, back to back, in the seconds before the deletion that then hung. See
// the batching note in applyTrackedLocationToPhotos.ts.
RCT_EXPORT_METHOD( updateAssetLocations
                  : ( NSArray<NSDictionary *> * )updates resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for ( NSDictionary *update in updates ) {
      NSString *phUri = update[@"phUri"];
      if ( ![phUri isKindOfClass:[NSString class]] ) { continue; }
      [ids addObject:( [phUri hasPrefix:@"ph://"] ? [phUri substringFromIndex:5] : phUri )];
    }

    PHFetchResult<PHAsset *> *fetched =
      [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];
    NSMutableDictionary<NSString *, PHAsset *> *assetsById = [NSMutableDictionary dictionary];
    for ( PHAsset *asset in fetched ) {
      NSString *identifier = asset.localIdentifier;
      NSRange slash = [identifier rangeOfString:@"/"];
      if ( slash.location != NSNotFound ) {
        identifier = [identifier substringToIndex:slash.location];
      }
      assetsById[identifier] = asset;
    }

    // Collect the assets that actually need a write. As in updateAssetLocation,
    // an asset that already carries its own GPS is left alone. An empty change
    // block can make performChanges never call its completion handler, so
    // resolve without opening a transaction at all.
    NSMutableArray<PHAsset *> *targets = [NSMutableArray array];
    NSMutableArray<CLLocation *> *locations = [NSMutableArray array];
    for ( NSDictionary *update in updates ) {
      NSString *phUri = update[@"phUri"];
      if ( ![phUri isKindOfClass:[NSString class]] ) { continue; }
      NSString *identifier = [phUri hasPrefix:@"ph://"] ? [phUri substringFromIndex:5] : phUri;
      NSRange slash = [identifier rangeOfString:@"/"];
      if ( slash.location != NSNotFound ) {
        identifier = [identifier substringToIndex:slash.location];
      }
      PHAsset *asset = assetsById[identifier];
      if ( !asset || asset.location != nil ) { continue; }
      [targets addObject:asset];
      [locations addObject:[[CLLocation alloc]
        initWithLatitude:[update[@"latitude"] doubleValue]
        longitude:[update[@"longitude"] doubleValue]]];
    }

    if ( targets.count == 0 ) {
      resolve( @{ @"updated": @0, @"requested": @( updates.count ) } );
      return;
    }

    void ( ^doUpdate )( void ) = ^{
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [targets enumerateObjectsUsingBlock:^( PHAsset *asset, NSUInteger idx, BOOL *stop ) {
          PHAssetChangeRequest *changeRequest =
            [PHAssetChangeRequest changeRequestForAsset:asset];
          changeRequest.location = locations[idx];
        }];
      } completionHandler:^( BOOL success, NSError *error ) {
        if ( success ) {
          resolve( @{ @"updated": @( targets.count ), @"requested": @( updates.count ) } );
        } else {
          reject( @"UPDATE_LOCATION_FAILED", error.localizedDescription, error );
        }
      }];
    };

    UIWindow *keyWindow = [self inatKeyWindow];
    UIViewController *root = keyWindow.rootViewController;
    if ( root.presentedViewController ) {
      [root dismissViewControllerAnimated:NO completion:^{
        inatAfterDismissalSettles( doUpdate );
      }];
    } else {
      doUpdate();
    }
  } );
}

// Loads an EXIF-oriented image downscaled to maxPixel on its longest side via
// ImageIO, which subsamples during decode instead of decoding the full
// resolution. Detection outputs normalized coords, so a downscaled input
// yields the same bounds at a fraction of the decode cost.
static UIImage *downscaledImageAtPath( NSString *path, CGFloat maxPixel )
{
  NSURL *url = [NSURL fileURLWithPath:path];
  CGImageSourceRef src = CGImageSourceCreateWithURL( (__bridge CFURLRef)url, nil );
  if ( !src ) return nil;
  NSDictionary *opts = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform:   @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize:          @( maxPixel ),
  };
  CGImageRef cg = CGImageSourceCreateThumbnailAtIndex( src, 0, (__bridge CFDictionaryRef)opts );
  CFRelease( src );
  if ( !cg ) return nil;
  UIImage *image = [UIImage imageWithCGImage:cg];
  CGImageRelease( cg );
  return image;
}

RCT_EXPORT_METHOD( detectSubjectBounds
                  : ( NSString * )inputPath model
                  : ( NSString * )model resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  UIImage  *image = downscaledImageAtPath( input, 1024 )
    ?: [UIImage imageWithContentsOfFile:input];
  if ( !image ) { resolve( [NSNull null] ); return; }

  NSDictionary *bounds = detectSubjectBoundsForImage( image );
  resolve( bounds ?: [NSNull null] );
}

// Writes a downscaled JPEG thumbnail (maxPixel px on the longest side) of a
// device photo to outputPath, so a photo grid can scroll without decoding
// full-resolution originals into every cell. ph:// PHAssets go through
// PHImageManager, using only renditions already on the device — never an
// iCloud download; file:// paths use ImageIO subsampling. Resolves a file://
// uri, or rejects on failure.
RCT_EXPORT_METHOD( createThumbnail
                  : ( NSString * )inputPath maxPixel
                  : ( nonnull NSNumber * )maxPixel outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *output = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  CGFloat   maxDim = [maxPixel floatValue];

  void (^writeThumbnail)( UIImage * ) = ^( UIImage *image ) {
    if ( !image ) { reject( @"THUMBNAIL_FAILED", @"Could not load image", nil ); return; }
    NSData *data = UIImageJPEGRepresentation( image, 0.8 );
    if ( !data ) { reject( @"THUMBNAIL_FAILED", @"Could not encode thumbnail", nil ); return; }
    [[NSFileManager defaultManager]
      createDirectoryAtPath:[output stringByDeletingLastPathComponent]
      withIntermediateDirectories:YES attributes:nil error:nil];
    if ( ![data writeToFile:output atomically:YES] ) {
      reject( @"THUMBNAIL_FAILED", @"Could not write thumbnail", nil ); return;
    }
    resolve( [NSString stringWithFormat:@"file://%@", output] );
  };

  if ( [inputPath hasPrefix:@"ph://"] ) {
    NSString *localId = [inputPath substringFromIndex:5];
    PHAsset *asset =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[localId] options:nil].firstObject;
    if ( !asset ) { reject( @"THUMBNAIL_FAILED", @"PHAsset not found", nil ); return; }

    PHImageRequestOptions *opts = [[PHImageRequestOptions alloc] init];
    // Never wait on iCloud for a grid tile. Asking for the high-quality format
    // over the network downloads the full-resolution original, which for an
    // offloaded asset takes tens of seconds — and since a handful of these
    // occupy every slot of the generation queue, a screen full of old photos
    // (Delete Unfaved is nothing but old photos) simply never renders. The
    // locally cached rendition Photos keeps for offloaded assets is what the
    // Photos app itself shows in its grid, and it is plenty for a tile.
    opts.networkAccessAllowed = NO;
    opts.deliveryMode         = PHImageRequestOptionsDeliveryModeOpportunistic;
    opts.resizeMode           = PHImageRequestOptionsResizeModeFast;

    __block BOOL     handled       = NO;
    __block UIImage *degradedImage = nil;
    [[PHImageManager defaultManager]
      requestImageForAsset:asset
      targetSize:CGSizeMake( maxDim, maxDim )
      contentMode:PHImageContentModeAspectFill
      options:opts
      resultHandler:^( UIImage *result, NSDictionary *info ) {
        if ( handled ) return;
        // Opportunistic delivery calls back twice when the full-quality
        // rendition isn't loaded: a cached low-res thumbnail first, then the
        // real one. Hold the low-res one and prefer whatever follows, but fall
        // back to it if nothing does — that's an offloaded asset, whose
        // original isn't on this device and isn't worth fetching for a tile.
        if ( [info[PHImageResultIsDegradedKey] boolValue] ) {
          if ( result ) degradedImage = result;
          return;
        }
        handled = YES;
        writeThumbnail( result ?: degradedImage );
      }];
    return;
  }

  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  writeThumbnail( downscaledImageAtPath( input, maxDim ) );
}

// cropX/cropY/cropW/cropH are normalized [0,1] coords of the subject region;
// pass null for all four to measure the full image.
RCT_EXPORT_METHOD( measureImageBrightness
                  : ( NSString * )inputPath cropX
                  : ( NSNumber * )cropX cropY
                  : ( NSNumber * )cropY cropW
                  : ( NSNumber * )cropW cropH
                  : ( NSNumber * )cropH resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  UIImage  *image = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { resolve( [NSNull null] ); return; }

  CGRect normCrop = ( cropX && cropY && cropW && cropH )
    ? CGRectMake( [cropX floatValue], [cropY floatValue],
                  [cropW floatValue], [cropH floatValue] )
    : CGRectMake( 0, 0, 1, 1 );

  float geomean = -1.0f;
  float median  = -1.0f;
  if ( !measureCropLuminance( image, normCrop, &geomean, &median ) ) {
    resolve( [NSNull null] );
    return;
  }
  resolve( @{ @"geomean": @( geomean ), @"median": @( median ) } );
}

// Multiplies every pixel by the brightness gain (scaled down to fit within
// maxDimension on its longest side, since this is used for thumbnail display)
// and writes the result as a JPEG to outputPath.
RCT_EXPORT_METHOD( adjustImageBrightness
                  : ( NSString * )inputPath adjustment
                  : ( nonnull NSNumber * )adjustment maxDimension
                  : ( nonnull NSNumber * )maxDimension outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input  = [inputPath  stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString *output = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  UIImage  *image  = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { reject( @"BRIGHTNESS_FAILED", @"Could not load image", nil ); return; }

  float k      = [adjustment floatValue];
  float maxDim = [maxDimension floatValue];
  float imgW   = (float)image.size.width;
  float imgH   = (float)image.size.height;
  float scale  = MIN( 1.0f, maxDim / MAX( imgW, imgH ) );
  int   W      = MAX( 1, (int)roundf( imgW * scale ) );
  int   H      = MAX( 1, (int)roundf( imgH * scale ) );

  // drawInRect: applies the UIImage's orientation, so this also normalizes
  // orientation to "up" the same way measureCropLuminance does above.
  UIGraphicsBeginImageContextWithOptions( CGSizeMake( W, H ), YES, 1.0 );
  [image drawInRect:CGRectMake( 0, 0, W, H )];
  UIImage *scaled = UIGraphicsGetImageFromCurrentImageContext( );
  UIGraphicsEndImageContext( );
  if ( !scaled.CGImage ) { reject( @"BRIGHTNESS_FAILED", @"Could not scale image", nil ); return; }

  CGColorSpaceRef cs  = CGColorSpaceCreateDeviceRGB( );
  unsigned char  *raw = (unsigned char *)malloc( (size_t)W * H * 4 );
  CGContextRef    bmp = CGBitmapContextCreate(
    raw, W, H, 8, (size_t)4 * W, cs,
    kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast );
  CGContextDrawImage( bmp, CGRectMake( 0, 0, W, H ), scaled.CGImage );
  CGColorSpaceRelease( cs );

  applyBrightnessMultiplyBuffer( raw, W * H, k );

  CGImageRef adjustedRef = CGBitmapContextCreateImage( bmp );
  CGContextRelease( bmp );
  free( raw );
  if ( !adjustedRef ) { reject( @"BRIGHTNESS_FAILED", @"Could not create adjusted image", nil ); return; }

  NSMutableData *destData = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
    (__bridge CFMutableDataRef)destData, CFSTR( "public.jpeg" ), 1, nil );
  if ( !destination ) {
    CGImageRelease( adjustedRef );
    reject( @"BRIGHTNESS_FAILED", @"Could not create image destination", nil );
    return;
  }
  CGImageDestinationAddImage( destination, adjustedRef, (__bridge CFDictionaryRef)@{
    (NSString *)kCGImageDestinationLossyCompressionQuality: @( 0.9 ),
  } );
  BOOL finalized = CGImageDestinationFinalize( destination );
  CFRelease( destination );
  CGImageRelease( adjustedRef );
  if ( !finalized ) { reject( @"BRIGHTNESS_FAILED", @"Could not encode adjusted image", nil ); return; }

  [[NSFileManager defaultManager]
    createDirectoryAtPath:[output stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];
  if ( ![destData writeToFile:output atomically:YES] ) {
    reject( @"BRIGHTNESS_FAILED", @"Could not write adjusted image", nil ); return;
  }
  resolve( output );
}

// ─── Video helpers ───────────────────────────────────────────────────────────

// Resolves a ph:// or file:// video URI to an AVAsset asynchronously.
static void resolveVideoAsset(
  NSString *videoUri,
  void (^completion)(AVAsset * _Nullable asset, NSError * _Nullable error)
) {
  if ( [videoUri hasPrefix:@"ph://"] ) {
    NSString *localIdentifier = [videoUri substringFromIndex:5];
    PHFetchResult<PHAsset *> *result =
      [PHAsset fetchAssetsWithLocalIdentifiers:@[localIdentifier] options:nil];
    PHAsset *phAsset = result.firstObject;
    if ( !phAsset ) {
      completion( nil, [NSError errorWithDomain:@"ImageCropper"
                                          code:-1
                                      userInfo:@{NSLocalizedDescriptionKey: @"PHAsset not found"}] );
      return;
    }
    PHVideoRequestOptions *opts = [[PHVideoRequestOptions alloc] init];
    opts.networkAccessAllowed = YES;
    opts.version = PHVideoRequestOptionsVersionOriginal;
    [[PHImageManager defaultManager]
      requestAVAssetForVideo:phAsset
      options:opts
      resultHandler:^( AVAsset *avAsset, AVAudioMix *__unused mix, NSDictionary *__unused info ) {
        if ( avAsset ) {
          completion( avAsset, nil );
        } else {
          completion( nil, [NSError errorWithDomain:@"ImageCropper"
                                              code:-1
                                          userInfo:@{NSLocalizedDescriptionKey: @"Could not load video asset"}] );
        }
      }];
  } else {
    NSString *path = [videoUri stringByReplacingOccurrencesOfString:@"file://" withString:@""];
    NSURL *url = [NSURL fileURLWithPath:path];
    completion( [AVURLAsset URLAssetWithURL:url options:nil], nil );
  }
}

RCT_EXPORT_METHOD( extractAudioFromVideo
                  : ( NSString * )videoUri destPath
                  : ( NSString * )destPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *outputPath = [destPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  [[NSFileManager defaultManager]
    createDirectoryAtPath:[outputPath stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];

  resolveVideoAsset( videoUri, ^( AVAsset *asset, NSError *error ) {
    if ( !asset ) {
      reject( @"AUDIO_EXTRACT_FAILED", error.localizedDescription, error );
      return;
    }
    AVAssetExportSession *exporter = [[AVAssetExportSession alloc]
      initWithAsset:asset presetName:AVAssetExportPresetAppleM4A];
    if ( !exporter ) {
      reject( @"AUDIO_EXTRACT_FAILED", @"Could not create export session", nil );
      return;
    }
    exporter.outputURL = [NSURL fileURLWithPath:outputPath];
    exporter.outputFileType = AVFileTypeAppleM4A;
    [exporter exportAsynchronouslyWithCompletionHandler:^{
      if ( exporter.status == AVAssetExportSessionStatusCompleted ) {
        resolve( [NSString stringWithFormat:@"file://%@", outputPath] );
      } else {
        reject( @"AUDIO_EXTRACT_FAILED",
                exporter.error.localizedDescription ?: @"Export failed",
                exporter.error );
      }
    }];
  } );
}

RCT_EXPORT_METHOD( convertVideoToGif
                  : ( NSString * )videoUri destPath
                  : ( NSString * )destPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *outputPath = [destPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  [[NSFileManager defaultManager]
    createDirectoryAtPath:[outputPath stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];

  resolveVideoAsset( videoUri, ^( AVAsset *asset, NSError *resolveError ) {
    if ( !asset ) {
      reject( @"GIF_FAILED", resolveError.localizedDescription, resolveError );
      return;
    }

    Float64 durationSecs = CMTimeGetSeconds( asset.duration );
    if ( durationSecs <= 0 ) durationSecs = 1.0;

    // Cap at 10 seconds, 2 fps → max 20 frames
    const int FPS = 2;
    const int MAX_FRAMES = 20;
    Float64 capped = MIN( durationSecs, 10.0 );
    int numFrames = (int)( capped * FPS );
    if ( numFrames < 1 ) numFrames = 1;
    if ( numFrames > MAX_FRAMES ) numFrames = MAX_FRAMES;

    AVAssetImageGenerator *gen = [[AVAssetImageGenerator alloc] initWithAsset:asset];
    gen.appliesPreferredTrackTransform = YES;
    gen.requestedTimeToleranceBefore = CMTimeMakeWithSeconds( 0.5, 600 );
    gen.requestedTimeToleranceAfter  = CMTimeMakeWithSeconds( 0.5, 600 );

    NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
    CGImageDestinationRef gifDest = CGImageDestinationCreateWithURL(
      (__bridge CFURLRef)outputURL, CFSTR( "com.compuserve.gif" ), numFrames, nil );
    if ( !gifDest ) {
      reject( @"GIF_FAILED", @"Could not create GIF destination", nil );
      return;
    }

    NSDictionary *fileProps = @{
      (__bridge NSString *)kCGImagePropertyGIFDictionary: @{
        (__bridge NSString *)kCGImagePropertyGIFLoopCount: @0,
      },
    };
    CGImageDestinationSetProperties( gifDest, (__bridge CFDictionaryRef)fileProps );

    NSDictionary *frameProps = @{
      (__bridge NSString *)kCGImagePropertyGIFDictionary: @{
        (__bridge NSString *)kCGImagePropertyGIFDelayTime: @( 1.0 / FPS ),
      },
    };

    int framesAdded = 0;
    for ( int i = 0; i < numFrames; i++ ) {
      Float64 t = ( capped / numFrames ) * i;
      CMTime requested = CMTimeMakeWithSeconds( t, 600 );
      CMTime actual;
      CGImageRef frame = [gen copyCGImageAtTime:requested actualTime:&actual error:nil];
      if ( frame ) {
        CGImageDestinationAddImage( gifDest, frame, (__bridge CFDictionaryRef)frameProps );
        CGImageRelease( frame );
        framesAdded++;
      }
    }

    if ( framesAdded == 0 ) {
      CFRelease( gifDest );
      reject( @"GIF_FAILED", @"No frames could be extracted", nil );
      return;
    }

    BOOL ok = CGImageDestinationFinalize( gifDest );
    CFRelease( gifDest );
    if ( ok ) {
      resolve( [NSString stringWithFormat:@"file://%@", outputPath] );
    } else {
      reject( @"GIF_FAILED", @"Could not write GIF file", nil );
    }
  } );
}

// ─── Device photo deletion ──────────────────────────────────────────────────

// The key/foreground window we'd delete photos from — the same window iOS uses
// to present its deletion confirmation.
- ( UIWindow * )inatKeyWindow
{
  // Prefer the window on a genuinely foreground-active scene rather than the
  // deprecated UIApplication.windows list, which isn't guaranteed to reflect
  // the active scene on multi-scene-capable builds. (sceneState=0 in the
  // logged diagnostics is UISceneActivationStateForegroundActive — i.e.
  // healthy — not "unattached"; that enum's unattached case is -1. So this
  // was not, on its own, the cause of the hang below.)
  if ( @available( iOS 13.0, * ) ) {
    for ( UIScene *scene in UIApplication.sharedApplication.connectedScenes ) {
      if ( ![scene isKindOfClass:[UIWindowScene class]] ) continue;
      if ( scene.activationState != UISceneActivationStateForegroundActive ) continue;
      UIWindowScene *windowScene = ( UIWindowScene * )scene;
      if ( @available( iOS 15.0, * ) ) {
        if ( windowScene.keyWindow ) { return windowScene.keyWindow; }
      }
      for ( UIWindow *w in windowScene.windows ) {
        if ( w.isKeyWindow ) { return w; }
      }
      for ( UIWindow *w in windowScene.windows ) {
        if ( !w.isHidden ) { return w; }
      }
    }
  }

  UIWindow *keyWindow = nil;
  for ( UIWindow *w in UIApplication.sharedApplication.windows ) {
    if ( w.isKeyWindow ) { keyWindow = w; break; }
  }
  if ( !keyWindow ) {
    for ( UIWindow *w in UIApplication.sharedApplication.windows ) {
      if ( !w.isHidden ) { keyWindow = w; break; }
    }
  }
  return keyWindow;
}

// Describes the modal presentation chain above the root VC. If anything is
// presented here, iOS cannot present its own deletion confirmation over it —
// that is the suspected cause of deletePhotos hanging with no prompt.
- ( NSString * )inatPresentedVCChain:( UIWindow * )window
{
  UIViewController *vc = window.rootViewController;
  if ( !vc ) { return @"(no rootViewController)"; }
  NSMutableString *chain = [NSMutableString stringWithString:NSStringFromClass( [vc class] )];
  while ( vc.presentedViewController ) {
    vc = vc.presentedViewController;
    [chain appendFormat:@" > %@", NSStringFromClass( [vc class] )];
  }
  return chain;
}

// Every window on a foreground scene, by class, level and visibility. iOS puts
// its deletion confirmation in a window of its own rather than in the key
// window's presentation chain, so inatPresentedVCChain structurally cannot see
// it: a hang where the alert was built but never made visible and one where it
// was never built at all both read as "vcChain=UIViewController". This tells
// them apart. The logged window *count* already varies across hangs (1 in the
// Aug 4 morning, 2 in the evening) with nothing to say what the extra one is.
- ( NSString * )inatWindowInventory
{
  NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
  if ( @available( iOS 13.0, * ) ) {
    for ( UIScene *scene in UIApplication.sharedApplication.connectedScenes ) {
      if ( ![scene isKindOfClass:[UIWindowScene class]] ) continue;
      [windows addObjectsFromArray:( ( UIWindowScene * )scene ).windows];
    }
  }
  if ( windows.count == 0 ) {
    [windows addObjectsFromArray:UIApplication.sharedApplication.windows];
  }
  NSMutableArray<NSString *> *described = [NSMutableArray array];
  for ( UIWindow *w in windows ) {
    [described addObject:[NSString stringWithFormat:
      @"%@(level=%.0f,hidden=%d,key=%d,alpha=%.2f,root=%@)",
      NSStringFromClass( [w class] ), ( double )w.windowLevel, w.isHidden, w.isKeyWindow,
      w.alpha,
      w.rootViewController ? NSStringFromClass( [w.rootViewController class] ) : @"nil"]];
  }
  return [described componentsJoinedByString:@" "];
}

// Returns a one-line snapshot of the state that governs whether the iOS
// deletion confirmation can present, plus how many of the passed identifiers
// actually resolve to real library assets. Logged from JS to Firebase right
// before a delete so a hung delete still leaves the diagnosing context behind.
RCT_EXPORT_METHOD( photoDeletionContext
                  : ( NSArray<NSString *> * )phUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    UIWindow *keyWindow = [self inatKeyWindow];
    NSString *vcChain = keyWindow
      ? [self inatPresentedVCChain:keyWindow]
      : @"(no key window)";
    BOOL hasScene = NO;
    long sceneState = -1;
    NSUInteger foregroundActiveScenes = 0;
    if ( @available( iOS 13.0, * ) ) {
      hasScene = keyWindow.windowScene != nil;
      if ( keyWindow.windowScene ) {
        sceneState = ( long )keyWindow.windowScene.activationState;
      }
      for ( UIScene *scene in UIApplication.sharedApplication.connectedScenes ) {
        if ( scene.activationState == UISceneActivationStateForegroundActive ) {
          foregroundActiveScenes += 1;
        }
      }
    }
    long auth;
    if ( @available( iOS 14.0, * ) ) {
      auth = ( long )[PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
    } else {
      auth = ( long )[PHPhotoLibrary authorizationStatus];
    }

    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for ( NSString *u in ( phUris ?: @[] ) ) {
      [ids addObject:( [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u )];
    }
    NSUInteger fetchedCount = ids.count > 0
      ? [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil].count
      : 0;

    NSString *info = [NSString stringWithFormat:
      @"appState=%ld hasWindowScene=%d sceneState=%ld fgActiveScenes=%lu authStatus=%ld "
      @"windows=%lu requested=%lu fetched=%lu vcChain=%@ windowList=[%@]",
      ( long )UIApplication.sharedApplication.applicationState,
      hasScene, sceneState, ( unsigned long )foregroundActiveScenes, auth,
      ( unsigned long )UIApplication.sharedApplication.windows.count,
      ( unsigned long )ids.count, ( unsigned long )fetchedCount,
      vcChain, [self inatWindowInventory]];
    resolve( info );
  } );
}

// Runs one PHPhotoLibrary transaction the app owns outright — creating an
// album — and reports whether it completes and how long it took.
//
// This is the one question the deletion diagnostics still can't answer. A
// deletion needs iOS to present a user-consent alert; creating an album does
// not. So when a deletion hangs, running this beside it separates the two
// candidates that are left: if the album transaction comes back promptly while
// the deletion never does, PHPhotoLibrary is healthy and the wedge is
// specifically the consent-alert path; if this hangs too, the wedge is deeper
// (photolibraryd, or transactions queueing behind the dead deletion) and
// nothing app-side can route around it.
//
// The album is deleted again immediately, in a second transaction the app also
// owns, and the promise resolves only once that cleanup has finished. Resolving
// early (as this first did) left the cleanup transaction running concurrently
// with whatever the caller did next, which is exactly the overlap
// enqueuePhotoLibraryWrite exists to prevent — harmless when the probe only ran
// beside an already-hung delete, not harmless now that it also runs immediately
// before a live one.
//
// "ok" is the *creation* transaction's result: that is the consent-free write
// being measured. A cleanup that never comes back leaves the promise pending,
// and the caller's timeout reads that as an unhealthy library, which it is.
RCT_EXPORT_METHOD( photoLibraryWriteProbe
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSDate *startedAt = [NSDate date];
  __block NSString *placeholderId = nil;
  [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
    PHAssetCollectionChangeRequest *request =
      [PHAssetCollectionChangeRequest creationRequestForAssetCollectionWithTitle:
        @"iNaturalist library probe"];
    placeholderId = request.placeholderForCreatedAssetCollection.localIdentifier;
  } completionHandler:^( BOOL success, NSError *error ) {
    void ( ^finish )( void ) = ^{
      resolve( @{
        @"ok": @( success ),
        @"ms": @( ( long )( [[NSDate date] timeIntervalSinceDate:startedAt] * 1000 ) ),
        @"error": error.localizedDescription ?: @"",
      } );
    };

    if ( !success || !placeholderId ) { finish( ); return; }
    PHFetchResult<PHAssetCollection *> *created =
      [PHAssetCollection fetchAssetCollectionsWithLocalIdentifiers:@[placeholderId] options:nil];
    if ( created.count == 0 ) { finish( ); return; }
    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      [PHAssetCollectionChangeRequest deleteAssetCollections:created];
    } completionHandler:^( BOOL cleanupSuccess, NSError *cleanupError ) {
      finish( );
    }];
  }];
}

// Returns the library photos whose capture time, floored to the second,
// matches one of the passed times, as parallel arrays of ph:// URIs and
// millisecond timestamps.
//
// Delete Unfaved used to do this by paging CameraRoll: up to 20 bridge round
// trips, each serializing a thousand full asset dictionaries, over a window
// spanning the user's entire observing history — and then JS threw away
// everything whose capture second didn't match an observation. Matching here
// means one call carrying only the photos that can matter, and no cap on how
// much of the library it can consider.
RCT_EXPORT_METHOD( photoAssetsMatchingCaptureTimes
                  : ( NSArray<NSNumber *> * )captureTimesMs fromTime
                  : ( NSNumber * )fromTimeMs toTime
                  : ( NSNumber * )toTimeMs resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  PHAuthorizationStatus status =
    [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite];
  if ( status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited ) {
    // Rejecting hands the scan back to CameraRoll, which knows how to ask.
    reject( @"PHOTO_LIBRARY_UNAUTHORIZED",
      [NSString stringWithFormat:@"photo library access not granted (status=%ld)",
        ( long )status],
      nil );
    return;
  }

  NSMutableSet<NSNumber *> *seconds =
    [NSMutableSet setWithCapacity:( captureTimesMs ?: @[] ).count];
  for ( NSNumber *ms in ( captureTimesMs ?: @[] ) ) {
    [seconds addObject:@( ( long long )floor( [ms doubleValue] / 1000.0 ) )];
  }
  if ( seconds.count == 0 ) {
    resolve( @{ @"uris": @[], @"timestamps": @[], @"scanned": @0 } );
    return;
  }

  // Off the module's serial queue: enumerating a large library takes long
  // enough to stall cropping and thumbnailing behind it.
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_USER_INITIATED, 0 ), ^{
    NSMutableArray<NSPredicate *> *predicates = [NSMutableArray arrayWithObject:
      [NSPredicate predicateWithFormat:@"mediaType == %d", PHAssetMediaTypeImage]];
    if ( fromTimeMs ) {
      [predicates addObject:[NSPredicate predicateWithFormat:@"creationDate >= %@",
        [NSDate dateWithTimeIntervalSince1970:[fromTimeMs doubleValue] / 1000.0]]];
    }
    if ( toTimeMs ) {
      [predicates addObject:[NSPredicate predicateWithFormat:@"creationDate <= %@",
        [NSDate dateWithTimeIntervalSince1970:[toTimeMs doubleValue] / 1000.0]]];
    }
    PHFetchOptions *options = [[PHFetchOptions alloc] init];
    options.predicate = [NSCompoundPredicate andPredicateWithSubpredicates:predicates];
    PHFetchResult<PHAsset *> *fetched = [PHAsset fetchAssetsWithOptions:options];

    NSMutableArray<NSString *> *uris = [NSMutableArray array];
    NSMutableArray<NSNumber *> *timestamps = [NSMutableArray array];
    [fetched enumerateObjectsUsingBlock:^( PHAsset *asset, NSUInteger idx, BOOL *stop ) {
      NSDate *created = asset.creationDate;
      if ( !created ) return;
      long long second = ( long long )floor( created.timeIntervalSince1970 );
      if ( ![seconds containsObject:@( second )] ) return;
      [uris addObject:[@"ph://" stringByAppendingString:asset.localIdentifier]];
      [timestamps addObject:@( second * 1000 )];
    }];

    resolve( @{
      @"uris": uris,
      @"timestamps": timestamps,
      @"scanned": @( fetched.count ),
    } );
  } );
}

// Returns the subset of the passed ph:// URIs that still resolve to a real
// asset in the photo library. An identifier orphaned by an earlier deletion or
// a device restore resolves to nothing: it can't be previewed and can't be
// deleted, so callers should drop it rather than showing it to the user.
RCT_EXPORT_METHOD( existingPhotoAssetUris
                  : ( NSArray<NSString *> * )phUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSArray<NSString *> *uris = phUris ?: @[];
  if ( uris.count == 0 ) {
    resolve( @[] );
    return;
  }

  // fetchAssetsWithLocalIdentifiers: matches an identifier with or without its
  // "/L0/001" suffix, but the returned localIdentifier always carries one, so
  // compare on the UUID ahead of the first slash.
  NSString * ( ^baseIdentifier )( NSString * ) = ^( NSString *uri ) {
    NSString *identifier = [uri hasPrefix:@"ph://"] ? [uri substringFromIndex:5] : uri;
    NSRange slash = [identifier rangeOfString:@"/"];
    return slash.location == NSNotFound
      ? identifier
      : [identifier substringToIndex:slash.location];
  };

  NSMutableArray<NSString *> *ids = [NSMutableArray array];
  for ( NSString *u in uris ) {
    [ids addObject:( [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u )];
  }
  PHFetchResult<PHAsset *> *fetched =
    [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];

  NSMutableSet<NSString *> *existing = [NSMutableSet set];
  for ( PHAsset *asset in fetched ) {
    [existing addObject:baseIdentifier( asset.localIdentifier )];
  }

  NSMutableArray<NSString *> *result = [NSMutableArray array];
  for ( NSString *u in uris ) {
    if ( [existing containsObject:baseIdentifier( u )] ) {
      [result addObject:u];
    }
  }
  resolve( result );
}

// Best-effort device-photo deletion. Dismisses any modal presented over the
// root VC first (iOS won't present its deletion confirmation over a modal),
// then requests deletion. Rejects with requested/fetched counts so JS can tell
// whether the identifiers resolved to real assets.
//
// appCreatedUris are the assets this app itself added to the library (the USB
// card offload; see appCreatedPhotoAssets.ts). PhotoKit deletes an app's own
// assets without presenting its confirmation alert, so those go in a
// transaction of their own, first, ahead of the prompted one. Two payoffs: the
// photos we own get deleted even when the prompted batch wedges, and the
// timings come back separately, which is the controlled comparison the log has
// been missing — a clean appCreatedMs beside a hung remainder pins the wedge
// on the consent alert.
RCT_EXPORT_METHOD( deletePhotoAssets
                  : ( NSArray<NSString *> * )phUris appCreated
                  : ( NSArray<NSString *> * )appCreatedUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for ( NSString *u in phUris ) {
      [ids addObject:( [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u )];
    }
    PHFetchResult<PHAsset *> *fetched =
      [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];

    // Deleting nothing can make performChanges never call its completion
    // handler (the request hangs). If none of the identifiers resolve to a
    // real asset, report that instead of issuing a no-op deletion.
    if ( fetched.count == 0 ) {
      resolve( @{ @"deleted": @0, @"requested": @( ids.count ), @"fetched": @0 } );
      return;
    }

    // Split the fetched assets by whether we created them. Identifiers are
    // compared on the UUID ahead of the first slash, as elsewhere in this file:
    // a stored "…/L0/001" and a bare UUID name the same asset.
    NSMutableSet<NSString *> *appCreatedBaseIds = [NSMutableSet set];
    for ( NSString *u in ( appCreatedUris ?: @[] ) ) {
      NSString *identifier = [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u;
      NSRange slash = [identifier rangeOfString:@"/"];
      [appCreatedBaseIds addObject:( slash.location == NSNotFound
        ? identifier
        : [identifier substringToIndex:slash.location] )];
    }
    NSMutableArray<PHAsset *> *ourAssets = [NSMutableArray array];
    NSMutableArray<PHAsset *> *theirAssets = [NSMutableArray array];
    for ( PHAsset *asset in fetched ) {
      NSString *identifier = asset.localIdentifier;
      NSRange slash = [identifier rangeOfString:@"/"];
      if ( slash.location != NSNotFound ) {
        identifier = [identifier substringToIndex:slash.location];
      }
      [( [appCreatedBaseIds containsObject:identifier] ? ourAssets : theirAssets )
        addObject:asset];
    }

    UIWindow *keyWindow = [self inatKeyWindow];
    long sceneState = -1;
    if ( @available( iOS 13.0, * ) && keyWindow.windowScene ) {
      sceneState = ( long )keyWindow.windowScene.activationState;
    }
    BOOL dismissedModal = keyWindow.rootViewController.presentedViewController != nil;

    // Prior diagnostics (a52d5cfcb, ef673d9a3) ruled out every known
    // presentation precondition (permission, scene, window, modal) yet
    // deletePhotos still hangs — so performChanges' completionHandler itself
    // may simply never fire even when the deletion goes through. Watch the
    // library independently: if the requested assets vanish, resolve from
    // here instead of waiting out JS's 120s timeout for a delete that already
    // succeeded. photoLibraryDidChange: below does the watching.
    //
    // A deletion that never came back leaves its state behind; drop it before
    // taking over, so the observer is registered once and watches one batch.
    if ( _pendingDeleteResolve || _pendingDeleteIds ) {
      [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
      _pendingDeleteResolve = nil;
      _pendingDeleteIds = nil;
    }
    _pendingDeleteIds = [ids copy];
    _pendingDeleteRequestedCount = ids.count;
    _pendingDeleteSettled = NO;
    _pendingDeleteResolve = resolve;
    _pendingDeleteGeneration += 1;
    NSUInteger generation = _pendingDeleteGeneration;
    [[PHPhotoLibrary sharedPhotoLibrary] registerChangeObserver:self];

    // Settles this call's promise exactly once, and tears down the shared
    // observer state only while this call still owns it. The generation check
    // matters because a hung deletion is abandoned by JS at 120s but is still
    // live down here: when its completion handler eventually did fire, it used
    // to set _pendingDeleteSettled and unregister the observer belonging to the
    // *next* deletion, whose own callback then found the flag already set and
    // never resolved — one wedged delete quietly wedging the delete after it.
    __block BOOL callSettled = NO;
    BOOL ( ^claimSettlement )( void ) = ^BOOL {
      if ( callSettled ) { return NO; }
      callSettled = YES;
      if ( self->_pendingDeleteGeneration != generation ) { return YES; }
      // photoLibraryDidChange: may already have resolved this same promise.
      if ( self->_pendingDeleteSettled ) { return NO; }
      self->_pendingDeleteSettled = YES;
      [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
      self->_pendingDeleteResolve = nil;
      self->_pendingDeleteIds = nil;
      return YES;
    };

    dispatch_after(
      dispatch_time( DISPATCH_TIME_NOW,
        ( int64_t )( kInatPendingDeleteWatchdogSeconds * NSEC_PER_SEC ) ),
      dispatch_get_main_queue(),
      ^{
        if ( !claimSettlement( ) ) { return; }
        reject( @"DELETE_NO_CALLBACK",
          [NSString stringWithFormat:
            @"deleteAssets for %lu asset(s) never called back in %.0fs",
            ( unsigned long )ids.count, kInatPendingDeleteWatchdogSeconds],
          nil );
      } );

    // Filled in by the app-created transaction, reported alongside whatever the
    // prompted one does. -1 means it never came back.
    __block NSInteger appCreatedMs = -1;
    __block NSUInteger appCreatedDeleted = 0;

    void ( ^finish )( BOOL, NSUInteger, NSError * ) =
      ^( BOOL success, NSUInteger deleted, NSError *error ) {
      dispatch_async( dispatch_get_main_queue(), ^{
        if ( !claimSettlement( ) ) { return; }
        if ( success ) {
          resolve( @{
            @"deleted": @( deleted ),
            @"requested": @( ids.count ),
            @"dismissedModal": @( dismissedModal ),
            @"sceneState": @( sceneState ),
            @"viaChangeObserver": @NO,
            @"appCreated": @( ourAssets.count ),
            @"appCreatedDeleted": @( appCreatedDeleted ),
            @"appCreatedMs": @( appCreatedMs ),
          } );
        } else {
          reject( @"DELETE_FAILED",
            [NSString stringWithFormat:
              @"requested=%lu fetched=%lu appCreated=%lu appCreatedMs=%ld "
              @"dismissedModal=%d sceneState=%ld error=%@",
              ( unsigned long )ids.count, ( unsigned long )fetched.count,
              ( unsigned long )ourAssets.count, ( long )appCreatedMs,
              dismissedModal, sceneState, error.localizedDescription ?: @"unknown"],
            error );
        }
      } );
    };

    // The prompted half: everything we didn't create. Runs after the
    // app-created transaction so its confirmation can't sit in front of one
    // that needs no confirmation at all.
    void ( ^deleteTheirs )( void ) = ^{
      if ( theirAssets.count == 0 ) {
        finish( YES, appCreatedDeleted, nil );
        return;
      }
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [PHAssetChangeRequest deleteAssets:theirAssets];
      } completionHandler:^( BOOL success, NSError *error ) {
        finish( success, appCreatedDeleted + ( success ? theirAssets.count : 0 ), error );
      }];
    };

    void ( ^doDelete )( void ) = ^{
      if ( ourAssets.count == 0 ) {
        deleteTheirs( );
        return;
      }
      NSDate *startedAt = [NSDate date];
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [PHAssetChangeRequest deleteAssets:ourAssets];
      } completionHandler:^( BOOL success, NSError *error ) {
        appCreatedMs = ( NSInteger )( [[NSDate date] timeIntervalSinceDate:startedAt] * 1000 );
        if ( success ) { appCreatedDeleted = ourAssets.count; }
        // A failure here is not fatal to the rest: the photos we don't own
        // still need deleting, and their transaction is the one that carries
        // the user's confirmation.
        deleteTheirs( );
      }];
    };

    UIViewController *root = keyWindow.rootViewController;
    if ( root.presentedViewController ) {
      [root dismissViewControllerAnimated:NO completion:^{
        inatAfterDismissalSettles( doDelete );
      }];
    } else {
      doDelete();
    }
  } );
}

// See the comment in deletePhotoAssets: this is the fallback path for a
// deletion that succeeds without performChanges' completion handler ever
// firing. Fires for every library change, so it must confirm the *specific*
// requested assets are gone before treating it as "our" delete completing.
- ( void )photoLibraryDidChange:( PHChange * )changeInstance
{
  NSArray<NSString *> *ids = _pendingDeleteIds;
  if ( !ids ) { return; }
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( self->_pendingDeleteSettled || !self->_pendingDeleteResolve ) { return; }
    PHFetchResult<PHAsset *> *stillPresent =
      [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];
    if ( stillPresent.count > 0 ) { return; }
    RCTPromiseResolveBlock resolve = self->_pendingDeleteResolve;
    self->_pendingDeleteSettled = YES;
    [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
    self->_pendingDeleteResolve = nil;
    self->_pendingDeleteIds = nil;
    resolve( @{
      @"deleted": @( self->_pendingDeleteRequestedCount ),
      @"requested": @( self->_pendingDeleteRequestedCount ),
      @"viaChangeObserver": @YES,
    } );
  } );
}

@end
