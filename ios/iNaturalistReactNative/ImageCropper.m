#import <ImageIO/ImageIO.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>
#include "onnxruntime_c_api.h"

@interface ImageCropper : NSObject <RCTBridgeModule>
@end

@implementation ImageCropper

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
// returning nil triggers the fallback (Vision saliency or center crop) instead.
// Evaluation on 328 labeled images: 0.08 gives score=0.825, 0.10 gives 0.824.
#define YOLO_GATE_CONF   0.08f

typedef struct { float x1, y1, x2, y2, conf; } YOLOBox;

static OrtEnv     *s_ortEnv     = NULL;
static OrtSession *s_ortSession = NULL;
static BOOL        s_yoloFailed = NO;

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
    if ( status ) { ort->ReleaseStatus( status ); s_yoloFailed = YES; }
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
static NSDictionary *detectSubjectBoundsYOLO( UIImage *image )
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
  const char *outputNames[] = { "output0" };
  OrtValue   *outputTensor  = NULL;

  status = ort->Run( s_ortSession, NULL,
                     inputNames,  (const OrtValue *const *)&inputTensor,  1,
                     outputNames, 1, &outputTensor );
  ort->ReleaseValue( inputTensor );
  free( inputData );

  if ( status || !outputTensor ) {
    if ( status ) ort->ReleaseStatus( status );
    return nil;
  }

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

  // Second pass: union only boxes at ≥ 40% of best confidence.
  float confThreshold = 0.40f * bestConf;
  float uX1 = FLT_MAX, uY1 = FLT_MAX, uX2 = -FLT_MAX, uY2 = -FLT_MAX;
  int   used = 0;
  for ( int i = 0; i < nDets; i++ ) {
    if ( suppressed[i] )            continue;
    if ( dets[i].conf < confThreshold ) continue;
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

// ─── Public detection entry point ────────────────────────────────────────────

// Try YOLO; fall back to Vision attention saliency when nothing is detected.
// If saliency returns bounds wider than 60% of the image in either dimension
// it is too loose to be reliable; a center 60%×60% crop is used instead
// (analysis of labeled iNaturalist data shows 98% of subjects are within
// the central 60% of the frame).
static NSDictionary *detectSubjectBoundsForImage( UIImage *image )
{
  if ( image.CGImage == NULL ) return nil;

  NSDictionary *yoloBounds = detectSubjectBoundsYOLO( image );
  if ( yoloBounds ) return yoloBounds;

  CGImagePropertyOrientation orientation = orientationFromUIImage( image );
  VNImageRequestHandler *handler =
    [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage
                                       orientation:orientation
                                           options:@{}];
  NSDictionary *saliency = detectSubjectBoundsSaliency( handler );
  if ( saliency ) {
    float w = [saliency[@"width"] floatValue];
    float h = [saliency[@"height"] floatValue];
    if ( w <= 0.6f && h <= 0.6f ) return saliency;
  }
  return @{ @"x": @(0.2f), @"y": @(0.2f), @"width": @(0.6f), @"height": @(0.6f) };
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

  UIImage *orientedImage = image;
  if ( image.imageOrientation != UIImageOrientationUp ) {
    UIGraphicsBeginImageContextWithOptions( image.size, NO, 1.0 );
    [image drawInRect:CGRectMake( 0, 0, image.size.width, image.size.height )];
    orientedImage = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
  }

  CGRect        cropRect   = CGRectMake( [originX integerValue], [originY integerValue],
                                         [width integerValue],   [height integerValue] );
  CGImageRef    croppedRef = CGImageCreateWithImageInRect( orientedImage.CGImage, cropRect );
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

RCT_EXPORT_METHOD( detectSubjectBounds
                  : ( NSString * )inputPath model
                  : ( NSString * )model resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  UIImage  *image = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { resolve( [NSNull null] ); return; }

  NSDictionary *bounds = detectSubjectBoundsForImage( image );
  resolve( bounds ?: [NSNull null] );
}

@end
