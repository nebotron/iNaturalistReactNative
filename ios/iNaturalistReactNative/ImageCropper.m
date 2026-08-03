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

@implementation ImageCropper {
  // Tracks the single in-flight deletePhotoAssets call (JS serializes calls
  // through one chain, so at most one is ever pending) so
  // photoLibraryDidChange: can tell whether it's watching for anything.
  NSArray<NSString *> *_pendingDeleteIds;
  NSUInteger _pendingDeleteRequestedCount;
  RCTPromiseResolveBlock _pendingDeleteResolve;
  BOOL _pendingDeleteSettled;
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

  __block void ( ^attemptExport )( NSInteger );
  attemptExport = ^( NSInteger attemptNumber ) {
    [[PHAssetResourceManager defaultManager]
      writeDataForAssetResource:photoResource
      toFile:[NSURL fileURLWithPath:dest]
      options:options
      completionHandler:^( NSError *error ) {
        if ( !error ) {
          resolve( @{
            @"uri": [NSString stringWithFormat:@"file://%@", dest],
            @"attempts": @( attemptNumber + 1 ),
          } );
          attemptExport = nil;
          return;
        }
        if ( attemptNumber + 1 >= maxAttempts ) {
          NSString *message = [NSString stringWithFormat:@"%@ (after %ld attempt(s))",
            error.localizedDescription, ( long )( attemptNumber + 1 )];
          reject( @"EXPORT_FAILED", message, error );
          attemptExport = nil;
          return;
        }
        NSTimeInterval delay = retryDelaySeconds[attemptNumber].doubleValue;
        dispatch_after(
          dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( delay * NSEC_PER_SEC ) ),
          dispatch_get_main_queue(),
          ^{ attemptExport( attemptNumber + 1 ); }
        );
      }];
  };
  attemptExport( 0 );
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
      [root dismissViewControllerAnimated:NO completion:doUpdate];
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
      @"windows=%lu requested=%lu fetched=%lu vcChain=%@",
      ( long )UIApplication.sharedApplication.applicationState,
      hasScene, sceneState, ( unsigned long )foregroundActiveScenes, auth,
      ( unsigned long )UIApplication.sharedApplication.windows.count,
      ( unsigned long )ids.count, ( unsigned long )fetchedCount,
      vcChain];
    resolve( info );
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
RCT_EXPORT_METHOD( deletePhotoAssets
                  : ( NSArray<NSString *> * )phUris resolver
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
    _pendingDeleteIds = [ids copy];
    _pendingDeleteRequestedCount = ids.count;
    _pendingDeleteSettled = NO;
    _pendingDeleteResolve = resolve;
    [[PHPhotoLibrary sharedPhotoLibrary] registerChangeObserver:self];

    void ( ^doDelete )( void ) = ^{
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [PHAssetChangeRequest deleteAssets:fetched];
      } completionHandler:^( BOOL success, NSError *error ) {
        dispatch_async( dispatch_get_main_queue(), ^{
          if ( self->_pendingDeleteSettled ) { return; }
          self->_pendingDeleteSettled = YES;
          [[PHPhotoLibrary sharedPhotoLibrary] unregisterChangeObserver:self];
          self->_pendingDeleteResolve = nil;
          self->_pendingDeleteIds = nil;
          if ( success ) {
            resolve( @{
              @"deleted": @( fetched.count ),
              @"requested": @( ids.count ),
              @"dismissedModal": @( dismissedModal ),
              @"sceneState": @( sceneState ),
              @"viaChangeObserver": @NO,
            } );
          } else {
            reject( @"DELETE_FAILED",
              [NSString stringWithFormat:
                @"requested=%lu fetched=%lu dismissedModal=%d sceneState=%ld error=%@",
                ( unsigned long )ids.count, ( unsigned long )fetched.count,
                dismissedModal, sceneState, error.localizedDescription ?: @"unknown"],
              error );
          }
        } );
      }];
    };

    UIViewController *root = keyWindow.rootViewController;
    if ( root.presentedViewController ) {
      [root dismissViewControllerAnimated:NO completion:doDelete];
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
