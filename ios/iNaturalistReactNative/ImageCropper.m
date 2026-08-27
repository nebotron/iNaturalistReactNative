#import <AVFoundation/AVFoundation.h>
#import <os/proc.h>
#import <CoreImage/CoreImage.h>
#import <CoreLocation/CoreLocation.h>
#import <ImageIO/ImageIO.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>
#include <stdlib.h>
#include <sys/utsname.h>
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

// ─── Photos-library write gate ──────────────────────────────────────────────
//
// performChanges' completion handler can simply stop firing (iOS 26; Apple
// Developer Forums 806349), and the transaction it opened stays open in
// photolibraryd afterwards — the watchdog above only gives up waiting for it,
// it cannot cancel it. The Aug 9 app log shows what happens next: a 47-asset
// deletion that never called back, the watchdog rejecting it at 150s, and a
// new deletion issued 13ms later that photoDeletionContext caught stacking on
// the still-running one (still outstanding at 150649ms). That one hung too,
// and so did a *one*-asset deletion two launches later: once the library stops
// answering, transaction size stops mattering.
//
// So a write issued while the library is silent buys nothing and costs the user
// 150s of waiting, on top of stacking transactions on a wedged photolibraryd —
// the one thing this file already knows makes the wedge worse. Refuse it
// instead, immediately, and say how long the library has been silent so JS can
// tell the user something true.
//
// The gate is opened on the main queue but closed from performChanges'
// completion handler, which PhotoKit runs on a queue of its own choosing, so
// every access takes the lock.
static NSUInteger inatPhotoWriteGeneration = 0;
static NSString *inatOutstandingPhotoWriteLabel = nil;
static NSDate *inatOutstandingPhotoWriteStartedAt = nil;
static NSObject *inatPhotoWriteLock = nil;

static NSObject *inatPhotoWriteGateLock( void )
{
  static dispatch_once_t once;
  dispatch_once( &once, ^{ inatPhotoWriteLock = [NSObject new]; } );
  return inatPhotoWriteLock;
}

static NSUInteger inatPhotoWriteBegan( NSString *label )
{
  @synchronized( inatPhotoWriteGateLock( ) ) {
    inatPhotoWriteGeneration += 1;
    inatOutstandingPhotoWriteLabel = label;
    inatOutstandingPhotoWriteStartedAt = [NSDate date];
    return inatPhotoWriteGeneration;
  }
}

// Only the write that is still outstanding can open the gate again. A
// completion handler that fires long after the change observer already answered
// for its transaction would otherwise clear a *later* write's gate and let a
// second transaction stack behind it — the exact thing the gate exists to stop.
// Pass 0 to clear whatever is outstanding, from evidence other than the
// callback (see photoLibraryDidChange:).
static void inatPhotoWriteEnded( NSUInteger generation )
{
  @synchronized( inatPhotoWriteGateLock( ) ) {
    if ( generation != 0 && generation != inatPhotoWriteGeneration ) { return; }
    inatOutstandingPhotoWriteLabel = nil;
    inatOutstandingPhotoWriteStartedAt = nil;
  }
}

// What the library still owes us, or nil when it is free to write to.
static NSString *inatOutstandingPhotoWriteLabelCopy( void )
{
  @synchronized( inatPhotoWriteGateLock( ) ) {
    return inatOutstandingPhotoWriteLabel;
  }
}

// Nil when the library is free to write to; otherwise why this write wasn't
// issued, in words JS can pass on.
static NSString *inatOutstandingPhotoWrite( void )
{
  @synchronized( inatPhotoWriteGateLock( ) ) {
    if ( !inatOutstandingPhotoWriteLabel ) { return nil; }
    return [NSString stringWithFormat:
      @"Photos has not answered %@ for %.0fs; it stops answering every write "
      @"after that, so this one was not issued",
      inatOutstandingPhotoWriteLabel,
      [[NSDate date] timeIntervalSinceDate:
        ( inatOutstandingPhotoWriteStartedAt ?: [NSDate date] )]];
  }
}

// What PhotoKit says about the assets a deletion was asked for.
//
// An asset this app is not allowed to delete — one synced from a computer, one
// belonging to a shared album rather than this library — is not a slow delete.
// deleteAssets has nothing it can do with it, and on iOS 26 that request
// neither presents a confirmation nor calls its completion handler: it just
// sits. The Aug 26 log is ten such assets. Every consent-free transaction
// around them landed, every transaction carrying them hung, the same ten
// survived three relaunches and a device restart, and one of them alone hung a
// single-asset deletion on Aug 25 — which is size, staleness and the
// confirmation dialog all ruled out at once.
static NSString *inatAssetDeletabilitySummary( id<NSFastEnumeration> assets )
{
  NSUInteger userLibrary = 0, cloudShared = 0, itunesSynced = 0, otherSource = 0;
  NSUInteger notDeletable = 0;
  for ( PHAsset *asset in assets ) {
    if ( asset.sourceType & PHAssetSourceTypeUserLibrary ) { userLibrary += 1; }
    else if ( asset.sourceType & PHAssetSourceTypeCloudShared ) { cloudShared += 1; }
    else if ( asset.sourceType & PHAssetSourceTypeiTunesSynced ) { itunesSynced += 1; }
    else { otherSource += 1; }
    if ( ![asset canPerformEditOperation:PHAssetEditOperationDelete] ) { notDeletable += 1; }
  }
  return [NSString stringWithFormat:
    @"userLibrary=%lu cloudShared=%lu itunesSynced=%lu otherSource=%lu notDeletable=%lu",
    ( unsigned long )userLibrary, ( unsigned long )cloudShared,
    ( unsigned long )itunesSynced, ( unsigned long )otherSource,
    ( unsigned long )notDeletable];
}

// The assets we didn't create go out in a single prompted transaction.
//
// They used to be chunked, ramping 15, 20, 25… on the theory that a prompted
// transaction above ~19 assets never calls its completion handler. The write
// gate above retires that theory: once the library stops answering, a
// one-asset deletion hangs as readily as a 283-asset one, so the size of the
// transaction is not what does it. The chunking's cost was real, though —
// PhotoKit presents its confirmation once per transaction, so a few hundred
// photos meant the user confirming the same cleanup nine times, at ~1.6s a
// transaction. One transaction is one confirmation and one such wait however
// many photos it carries.

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
  // Whether the deletion's transaction is still outstanding, and how big it
  // is. photoDeletionContext reports these, so the hang diagnostic that fires
  // 5s in says whether PhotoKit ever took the transaction and how long it has
  // been sitting on it.
  BOOL _deleteTransactionActive;
  NSUInteger _deleteTransactionCount;
  NSDate *_deleteTransactionStartedAt;
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
// returning nil triggers the Vision attention-saliency fallback instead. Below ~0.5
// the detector's crop scores worse against the crop log than simply framing the
// whole photo, so the fallback is the better bet there.
#define YOLO_GATE_CONF   0.50f
// Union: include box if its confidence is at least this fraction of the best box.
// Cap at this many boxes to prevent noisy low-conf detections from bloating the union.
#define YOLO_UNION_THRESH 0.60f
#define YOLO_UNION_MAX_K  3

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
    if ( status ) { ort->ReleaseStatus( status ); s_yoloFailed = YES; return; }
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
  OrtValue   *outputs[1]    = { NULL };

  status = ort->Run( s_ortSession, NULL,
                     inputNames,  (const OrtValue *const *)&inputTensor,  1,
                     outputNames, 1, outputs );
  ort->ReleaseValue( inputTensor );
  free( inputData );

  if ( status || !outputs[0] ) {
    if ( status ) ort->ReleaseStatus( status );
    return nil;
  }

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
static NSDictionary *detectSubjectBoundsForImage( UIImage *image )
{
  if ( image.CGImage == NULL ) return nil;

  NSDictionary *bounds = detectSubjectBoundsYOLO( image );

  if ( !bounds ) {
    CGImagePropertyOrientation orientation = orientationFromUIImage( image );
    VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage
                                         orientation:orientation
                                             options:@{}];
    bounds = detectSubjectBoundsSaliency( handler );
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

    NSString *busy = inatOutstandingPhotoWrite( );
    if ( busy ) {
      reject( @"PHOTOS_LIBRARY_BUSY", busy, nil );
      return;
    }

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
      NSUInteger writeToken = inatPhotoWriteBegan( @"updateAssetLocation(1)" );
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        PHAssetChangeRequest *changeRequest = [PHAssetChangeRequest changeRequestForAsset:asset];
        changeRequest.location = location;
      } completionHandler:^( BOOL success, NSError *error ) {
        inatPhotoWriteEnded( writeToken );
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
    NSString *busy = inatOutstandingPhotoWrite( );
    if ( busy ) {
      reject( @"PHOTOS_LIBRARY_BUSY", busy, nil );
      return;
    }

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
      NSUInteger writeToken = inatPhotoWriteBegan(
        [NSString stringWithFormat:@"updateAssetLocations(%lu)",
          ( unsigned long )targets.count] );
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [targets enumerateObjectsUsingBlock:^( PHAsset *asset, NSUInteger idx, BOOL *stop ) {
          PHAssetChangeRequest *changeRequest =
            [PHAssetChangeRequest changeRequestForAsset:asset];
          changeRequest.location = locations[idx];
        }];
      } completionHandler:^( BOOL success, NSError *error ) {
        inatPhotoWriteEnded( writeToken );
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

// Matches the ph:// branch's highQualityDecode threshold in createThumbnail:
// below this, a request is a grid tile that wants speed; at or above it, only
// the Group Photos crop overlay is asking, and it wants real detail.
static const CGFloat kFileHighQualityMinPixel = 8192;

// Scales an already-decoded image down to maxPixel on its longest side, so
// the safety valve in FULL_RESOLUTION_MAX_PIXEL (JS) still caps memory for a
// pathological source (a stitched panorama, say) even on the full-decode path.
static UIImage *clampToMaxPixel( UIImage *image, CGFloat maxPixel )
{
  CGFloat longest = MAX( image.size.width * image.scale, image.size.height * image.scale );
  if ( longest <= maxPixel ) return image;
  CGFloat scale = maxPixel / longest;
  CGSize newSize = CGSizeMake( image.size.width * scale, image.size.height * scale );
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.scale = 1;
  UIGraphicsImageRenderer *renderer =
    [[UIGraphicsImageRenderer alloc] initWithSize:newSize format:format];
  return [renderer imageWithActions:^( UIGraphicsImageRendererContext *context ) {
    [image drawInRect:CGRectMake( 0, 0, newSize.width, newSize.height )];
  }];
}

// Defined below, alongside the encode it was written for.
static UIImage *rasterizedImage( UIImage *image );

// EXIF orientation of an image source, as a UIImageOrientation.
// CGImageSourceCreateImageAtIndex hands back the pixels exactly as they are
// stored, with none of the rotation the EXIF tag asks for -- unlike the
// thumbnail path below, which applies it via kCGImageSourceCreateThumbnailWith
// Transform. Without this a portrait photo's full-resolution thumbnail came
// back on its side, so a Group Photos cell rotated the moment the
// full-resolution file replaced the thumbnail it was showing.
static UIImageOrientation orientationForImageSource( CGImageSourceRef src )
{
  NSDictionary *props =
    CFBridgingRelease( CGImageSourceCopyPropertiesAtIndex( src, 0, NULL ) );
  switch ( [props[(__bridge NSString *)kCGImagePropertyOrientation] intValue] ) {
    case 2:  return UIImageOrientationUpMirrored;
    case 3:  return UIImageOrientationDown;
    case 4:  return UIImageOrientationDownMirrored;
    case 5:  return UIImageOrientationLeftMirrored;
    case 6:  return UIImageOrientationRight;
    case 7:  return UIImageOrientationRightMirrored;
    case 8:  return UIImageOrientationLeft;
    default: return UIImageOrientationUp;
  }
}

// Loads an EXIF-oriented image downscaled to maxPixel on its longest side via
// ImageIO, which subsamples during decode instead of decoding the full
// resolution. Detection outputs normalized coords, so a downscaled input
// yields the same bounds at a fraction of the decode cost.
//
// CGImageSourceCreateThumbnailAtIndex is a speed-optimized API: for a RAW
// file (.CR3, etc.) it commonly hands back the file's embedded preview JPEG
// rather than truly demosaicing the sensor data, even with
// kCGImageSourceCreateThumbnailFromImageAlways set -- the dimensions can
// still match the sensor, but the actual detail is whatever quality the
// camera baked into that preview. That's what kept a RAW photo's crop
// overlay looking soft/pixelated no matter how high maxPixel was raised.
// At or above kFileHighQualityMinPixel, decode the image data directly
// instead of asking for a thumbnail.
// The speed-optimized path: ImageIO subsamples during decode, and for a RAW
// file hands back the embedded preview the camera baked in.
static UIImage *thumbnailFromImageSource( CGImageSourceRef src, CGFloat maxPixel )
{
  NSDictionary *opts = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform:   @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize:          @( maxPixel ),
  };
  CGImageRef cg = CGImageSourceCreateThumbnailAtIndex( src, 0, (__bridge CFDictionaryRef)opts );
  if ( !cg ) return nil;
  UIImage *image = [UIImage imageWithCGImage:cg];
  CGImageRelease( cg );
  return image;
}

// failureReason, when the caller passes one, receives a short description of
// which step produced nothing, and what the file looked like to ImageIO.
// "Could not load image" was the same message whether the file had no decoder
// at all, decoded to an empty image, or drew nothing — three different bugs
// with three different fixes, and 1,137 lines of the Aug 6-19 app log that
// could not say which.
static UIImage *downscaledImageAtPath(
  NSString *path, CGFloat maxPixel, NSString **failureReason )
{
  NSURL *url = [NSURL fileURLWithPath:path];
  CGImageSourceRef src = CGImageSourceCreateWithURL( (__bridge CFURLRef)url, nil );
  if ( !src ) {
    if ( failureReason ) *failureReason = @"no image source for file";
    return nil;
  }
  // Copied, not borrowed: the source is released before these are used below.
  NSString *sourceType = [(__bridge NSString *)CGImageSourceGetType( src ) copy];
  size_t    imageCount = CGImageSourceGetCount( src );

  if ( maxPixel >= kFileHighQualityMinPixel ) {
    // Decode now rather than on first draw. Without this the CGImage that
    // comes back carries only a promise of pixels, and for a RAW original
    // (.CR3) that demosaic is first forced inside UIImageJPEGRepresentation --
    // by which point the image source it needs has been released and a failure
    // has nowhere to be reported. What landed on disk then was a JPEG
    // container with no image in it: 762 bytes, the same 762 bytes whichever
    // photo it came from, cached under that photo's key and undrawable from
    // then on. Decoding here turns that into a NULL we refuse to write.
    NSDictionary *fullOpts = @{
      (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES,
    };
    CGImageRef full =
      CGImageSourceCreateImageAtIndex( src, 0, (__bridge CFDictionaryRef)fullOpts );
    UIImage *image = full
      ? [UIImage imageWithCGImage:full scale:1 orientation:orientationForImageSource( src )]
      : nil;
    if ( full ) CGImageRelease( full );
    // kCGImageSourceShouldCacheImmediately is a hint the RAW decoder is free
    // to ignore, so draw the image here to actually materialize its pixels --
    // and do it while the image source is still alive, since releasing it
    // while the decode was still deferred is what left that decode with no
    // source. rasterizedImage returns nil when the draw put nothing there,
    // rather than the frame of solid black it would otherwise encode.
    UIImage *decoded = image
      ? rasterizedImage( image )
      : nil;
    // iOS's ImageIO reads a Canon CR3's embedded preview but cannot demosaic
    // its sensor data, so the full decode above returns NULL (in ~40ms, far too
    // fast to have been a demosaic) for every RAW original from that camera.
    // Failing outright meant the caller fell back to displaying the .CR3 file
    // itself, which swapped a Group Photos cell's working thumbnail for a file
    // <Image> draws nothing for -- leaving the cell's black backdrop alone on
    // screen. The embedded preview is the largest image iOS can actually
    // produce for these, so it beats having none.
    if ( !decoded ) decoded = thumbnailFromImageSource( src, maxPixel );
    CFRelease( src );
    if ( !decoded ) {
      if ( failureReason ) {
        *failureReason = [NSString stringWithFormat:
          @"neither the full decode nor the embedded preview produced an image "
           "(type=%@, images=%zu)", sourceType ?: @"unknown", imageCount];
      }
      return nil;
    }
    return clampToMaxPixel( decoded, maxPixel );
  }

  UIImage *image = thumbnailFromImageSource( src, maxPixel );
  CFRelease( src );
  if ( !image && failureReason ) {
    *failureReason = [NSString stringWithFormat:
      @"thumbnail decode produced no image (type=%@, images=%zu)",
      sourceType ?: @"unknown", imageCount];
  }
  return image;
}

RCT_EXPORT_METHOD( detectSubjectBounds
                  : ( NSString * )inputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  UIImage  *image = downscaledImageAtPath( input, 1024, NULL )
    ?: [UIImage imageWithContentsOfFile:input];
  if ( !image ) { resolve( [NSNull null] ); return; }

  NSDictionary *bounds = detectSubjectBoundsForImage( image );
  resolve( bounds ?: [NSNull null] );
}

// Whether JPEG data is something a decoder will actually open, checked the
// same way React Native's image loader checks it. Encoding a UIImage whose
// CGImage decodes lazily (a RAW original's, say) can hand back a file that is
// nothing but JPEG headers and tables — a fixed ~760 bytes, no image in it —
// and nothing upstream notices, because the encode "succeeded".
static BOOL jpegDataIsDecodable( NSData *data )
{
  if ( data.length == 0 ) return NO;
  UIImage *decoded = [UIImage imageWithData:data];
  return decoded != nil && decoded.size.width > 0 && decoded.size.height > 0;
}

// Longest side the encoded thumbnail is decoded back down to for the check
// below. ImageIO downsamples a JPEG through its DCT rather than decoding it
// whole, so this costs a fraction of the encode that produced the data, and at
// this size any real subject still leaves pixels that aren't black.
static const size_t kBlackProbePixel = 32;

// Highest channel value still counted as black. A buffer that was cleared and
// never drawn over encodes as exact zeros; JPEG quantization and chroma
// subsampling move that by a hair, not by this much.
static const uint8_t kBlackProbeThreshold = 6;

// Whether encoded JPEG data holds nothing but black pixels. Decodable is not
// the same as a picture of the photo: encoding a UIImage whose CGImage decodes
// lazily can hand back the decoder's own cleared buffer when that decode turns
// into a no-op, and that is a perfectly openable JPEG of the right dimensions
// that is entirely black -- which jpegDataIsDecodable cannot tell from a
// photograph of the night sky. Cached on disk under the photo's key and served
// to every cell from then on, that file is what left Group Photos cells stuck
// as black squares with no load error anywhere to explain them.
static BOOL jpegDataIsBlack( NSData *data )
{
  CGImageSourceRef source = CGImageSourceCreateWithData( (__bridge CFDataRef)data, NULL );
  if ( !source ) return NO;
  NSDictionary *opts = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize:          @( kBlackProbePixel ),
  };
  CGImageRef probe =
    CGImageSourceCreateThumbnailAtIndex( source, 0, (__bridge CFDictionaryRef)opts );
  CFRelease( source );
  if ( !probe ) return NO;

  size_t width  = CGImageGetWidth( probe );
  size_t height = CGImageGetHeight( probe );
  if ( width == 0 || height == 0 ) { CGImageRelease( probe ); return NO; }

  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB( );
  // Same layout as the rasterization buffer: no alpha, so every pixel is the
  // four bytes stepped through below.
  CGContextRef ctx = CGBitmapContextCreate(
    NULL, width, height, 8, 0, space,
    kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little
  );
  CGColorSpaceRelease( space );
  if ( !ctx ) { CGImageRelease( probe ); return NO; }
  CGContextDrawImage( ctx, CGRectMake( 0, 0, width, height ), probe );
  CGImageRelease( probe );

  const uint8_t *pixels      = CGBitmapContextGetData( ctx );
  size_t         bytesPerRow = CGBitmapContextGetBytesPerRow( ctx );
  BOOL           black       = pixels != NULL;
  for ( size_t y = 0; black && y < height; y += 1 ) {
    const uint8_t *row = pixels + ( y * bytesPerRow );
    for ( size_t x = 0; x < width; x += 1 ) {
      const uint8_t *px = row + ( x * 4 );
      if ( px[0] > kBlackProbeThreshold
        || px[1] > kBlackProbeThreshold
        || px[2] > kBlackProbeThreshold ) { black = NO; break; }
    }
  }
  CGContextRelease( ctx );
  return black;
}

// Longest side a rasterization is allowed to allocate a bitmap for. Well above
// any camera photo, and four bytes a pixel at this size is already 256MB, so a
// pathological source (a stitched panorama, say) can't take the app down.
static const CGFloat kMaxRasterizePixel = 8192;

// Colour the rasterization buffer is cleared to before the image is drawn
// over it. A CGImage whose pixels never materialized -- a RAW original whose
// demosaic failed -- draws as a no-op, and over the opaque buffer this used to
// allocate (cleared to black) that produced a perfectly decodable, entirely
// black JPEG. Nothing downstream could tell that from a photo of the night
// sky, so it was written to the cache under the photo's key and handed to
// every Group Photos cell that asked for it from then on, with no load error
// anywhere to say why the cell was a black square. Clearing to a colour no
// photograph is uniformly made of makes a no-op draw something we can detect.
// Magenta reads the same forwards and backwards, so the check below doesn't
// care whether the buffer's channel order is RGB or BGR.
static const uint8_t kRasterizeSentinel[3] = { 255, 0, 255 };

// Points sampled per axis when checking whether anything was drawn. A partial
// draw isn't a thing the decoder does -- either the pixels exist or they don't
// -- so this only has to be dense enough to not land entirely on a magenta
// subject by chance.
static const size_t kBlankProbeSteps = 32;

static BOOL bitmapIsBlank(
  const uint8_t *pixels,
  size_t         width,
  size_t         height,
  size_t         bytesPerRow
)
{
  size_t stepX = MAX( (size_t)1, width / kBlankProbeSteps );
  size_t stepY = MAX( (size_t)1, height / kBlankProbeSteps );
  for ( size_t y = 0; y < height; y += stepY ) {
    const uint8_t *row = pixels + ( y * bytesPerRow );
    for ( size_t x = 0; x < width; x += stepX ) {
      const uint8_t *px = row + ( x * 4 );
      if ( px[0] != kRasterizeSentinel[0]
        || px[1] != kRasterizeSentinel[1]
        || px[2] != kRasterizeSentinel[2] ) return NO;
    }
  }
  return YES;
}

// Draws the image into a fresh opaque RGB bitmap, forcing any deferred decode
// to happen now (and against the source data, which is still around) rather
// than inside the JPEG encoder. Returns nil if the draw put nothing there,
// so a failed decode can't be mistaken for a black photograph.
static UIImage *rasterizedImage( UIImage *image )
{
  CGSize size = CGSizeMake( image.size.width * image.scale, image.size.height * image.scale );
  CGFloat longest = MAX( size.width, size.height );
  if ( longest > kMaxRasterizePixel ) {
    CGFloat scale = kMaxRasterizePixel / longest;
    size = CGSizeMake( size.width * scale, size.height * scale );
  }
  if ( size.width < 1 || size.height < 1 ) return nil;
  size_t width  = (size_t)size.width;
  size_t height = (size_t)size.height;

  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB( );
  // No alpha channel, so the JPEG encoder gets an opaque bitmap and every
  // pixel is the four bytes bitmapIsBlank steps through.
  CGContextRef ctx = CGBitmapContextCreate(
    NULL, width, height, 8, 0, space,
    kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little
  );
  CGColorSpaceRelease( space );
  if ( !ctx ) return nil;

  CGContextSetRGBFillColor(
    ctx,
    kRasterizeSentinel[0] / 255.0,
    kRasterizeSentinel[1] / 255.0,
    kRasterizeSentinel[2] / 255.0,
    1
  );
  CGContextFillRect( ctx, CGRectMake( 0, 0, width, height ) );
  // drawInRect: is what bakes the image's EXIF orientation in, and it expects
  // UIKit's top-left origin rather than the bitmap context's bottom-left one.
  CGContextTranslateCTM( ctx, 0, height );
  CGContextScaleCTM( ctx, 1, -1 );
  UIGraphicsPushContext( ctx );
  [image drawInRect:CGRectMake( 0, 0, width, height )];
  UIGraphicsPopContext( );

  const uint8_t *pixels = CGBitmapContextGetData( ctx );
  BOOL blank = pixels
    && bitmapIsBlank( pixels, width, height, CGBitmapContextGetBytesPerRow( ctx ) );
  CGImageRef cg = blank
    ? NULL
    : CGBitmapContextCreateImage( ctx );
  CGContextRelease( ctx );
  if ( !cg ) return nil;
  UIImage *rasterized = [UIImage imageWithCGImage:cg];
  CGImageRelease( cg );
  return rasterized;
}

// JPEG data for a thumbnail, or nil if this image can't be encoded into one a
// decoder will open and find the photo in. A thumbnail that isn't the photo is
// worse than no thumbnail at all: it is cached on disk under the photo's key
// and served to every cell that asks for it from then on, so the photo it
// stands for can never be drawn — an unopenable one left Group Photos cells
// showing an invisible crop overlay whose pinch gesture appeared dead and whose
// subject detection appeared never to return, and an openable but empty one
// left them as plain black squares.
static NSData *encodedThumbnailData( UIImage *image, NSString **reason )
{
  NSData *data = UIImageJPEGRepresentation( image, 0.8 );
  // An all-black encode is treated exactly like an unopenable one, because it
  // has the same cause -- a decode that never produced any pixels -- and only
  // the rasterization below can tell that apart from a black photograph: it
  // draws over a colour no photograph is uniformly made of, so a photo that
  // really is black comes back drawn and is encoded as normal, while a no-op
  // draw comes back nil and this photo gets no cached thumbnail at all.
  if ( jpegDataIsDecodable( data ) && !jpegDataIsBlack( data ) ) return data;
  UIImage *rasterized = rasterizedImage( image );
  data = rasterized ? UIImageJPEGRepresentation( rasterized, 0.8 ) : nil;
  if ( jpegDataIsDecodable( data ) ) return data;
  if ( reason ) {
    *reason = rasterized
      ? @"Could not encode thumbnail"
      : @"Thumbnail decode produced no pixels";
  }
  return nil;
}

// Writes a downscaled JPEG thumbnail (maxPixel px on the longest side) of a
// device photo to outputPath, so a photo grid can scroll without decoding
// full-resolution originals into every cell. ph:// PHAssets go through
// PHImageManager: grid-tile requests use only renditions already on the
// device and never an iCloud download, but the crop overlay's high-quality
// request (see highQualityDecode below) will fetch the original from iCloud
// if that's what it takes to get real full-resolution detail; file:// paths
// use ImageIO subsampling. Resolves a file:// uri, or rejects on failure.
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
    NSString *encodeFailure = nil;
    NSData   *data          = encodedThumbnailData( image, &encodeFailure );
    if ( !data ) {
      reject( @"THUMBNAIL_FAILED", encodeFailure ?: @"Could not encode thumbnail", nil );
      return;
    }
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

    // A grid tile asks for a few hundred px and wants it fast; the Group
    // Photos crop overlay asks for this same method at a size comfortably
    // above any camera photo (see FULL_RESOLUTION_MAX_PIXEL in
    // GroupPhotoCropImage.tsx) because it wants the actual original detail to
    // crop into. Fast/Opportunistic optimizes for speed over matching the
    // requested size, so at that size it was handing back whatever smaller
    // cached preview Photos already had -- the crop overlay's "full
    // resolution" request was silently getting a soft, low-quality rendition
    // no matter how high the JS-side cap was raised.
    BOOL highQualityDecode = maxDim >= kFileHighQualityMinPixel;

    PHImageRequestOptions *opts = [[PHImageRequestOptions alloc] init];
    // Never wait on iCloud for a grid tile. Asking for the high-quality format
    // over the network downloads the full-resolution original, which for an
    // offloaded asset takes tens of seconds — and since a handful of these
    // occupy every slot of the generation queue, a screen full of old photos
    // (Delete Unfaved is nothing but old photos) simply never renders. The
    // locally cached rendition Photos keeps for offloaded assets is what the
    // Photos app itself shows in its grid, and it is plenty for a tile.
    //
    // The crop overlay is the opposite case: it's one deliberate request the
    // user is actively waiting on to frame a crop, not one of hundreds in a
    // scroll list, and ResizeModeExact/HighQualityFormat can't produce real
    // full-resolution detail from a local rendition that was never that big
    // to begin with -- for an optimized/offloaded asset, disallowing network
    // access there just serves the same soft preview the tile path uses.
    opts.networkAccessAllowed = highQualityDecode;
    opts.deliveryMode         = highQualityDecode
      ? PHImageRequestOptionsDeliveryModeHighQualityFormat
      : PHImageRequestOptionsDeliveryModeOpportunistic;
    opts.resizeMode           = highQualityDecode
      ? PHImageRequestOptionsResizeModeExact
      : PHImageRequestOptionsResizeModeFast;

    __block BOOL     handled       = NO;
    __block UIImage *degradedImage = nil;
    [[PHImageManager defaultManager]
      requestImageForAsset:asset
      targetSize:CGSizeMake( maxDim, maxDim )
      // Always the whole frame. AspectFill crops to a square, and the Group
      // Photos crop overlay builds a cell out of this same tile-sized file: it
      // measures it for the photo's aspect ratio, detects the subject in it,
      // and draws it under the crop box. A square-cropped thumbnail makes every
      // one of those describe a different frame from the original the crop is
      // finally applied to, and a cell framed at the wrong aspect ratio is
      // translated off by the difference -- far enough, for a tightly framed
      // subject, to leave nothing on screen but the overlay's black backdrop.
      // A square grid tile is unaffected: it draws its thumbnail with
      // resizeMode cover, which crops to the square at draw time, and the
      // uncropped frame is fewer pixels rather than more.
      contentMode:PHImageContentModeAspectFit
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
  NSString *failureReason = nil;
  UIImage  *image = downscaledImageAtPath( input, maxDim, &failureReason );
  if ( !image ) {
    // The file's size distinguishes a file that never finished copying from a
    // whole one this build simply cannot decode.
    unsigned long long bytes = [[[NSFileManager defaultManager]
      attributesOfItemAtPath:input error:nil] fileSize];
    reject( @"THUMBNAIL_FAILED", [NSString stringWithFormat:@"%@, %llu bytes",
      failureReason ?: @"Could not load image", bytes], nil );
    return;
  }
  writeThumbnail( image );
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
  // orientation to "up".
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


// How much more memory iOS will let this process allocate before it kills it.
// A run that dies with the app in the foreground, mid-native-call, is usually
// one iOS killed for memory — and nothing in the log could say so: the Aug 20
// offload died at "saving 13/29" two seconds after its last progress, with the
// app active, and left no other trace.
RCT_EXPORT_METHOD( availableMemoryBytes
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  resolve( @( (double)os_proc_available_memory( ) ) );
}

// Decodes a camera raw through Core Image's RAW pipeline and writes it as a
// JPEG, scaled to fit maxPixel.
//
// This is a different decoder from the one everything else here uses. ImageIO
// cannot demosaic a CR3: CGImageSourceCreateImageAtIndex returns NULL and the
// thumbnail path hands back the full-size JPEG preview the camera embedded —
// the camera's own rendering, with the camera's own corrections already in it.
// Core Image's RAW pipeline demosaics the sensor data instead, which is the
// only way the app ever sees what the sensor actually recorded.
//
// Resolves { decoded: NO, reason } rather than rejecting when this build of
// iOS has no decoder for the file, so the caller can fall back to the old path
// instead of failing an import.
RCT_EXPORT_METHOD( decodeRawToJpeg
                  : ( NSString * )inputPath maxPixel
                  : ( nonnull NSNumber * )maxPixel outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString       *input   = [inputPath  stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString       *output  = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSTimeInterval  started = [NSDate timeIntervalSinceReferenceDate];
  NSURL          *url     = [NSURL fileURLWithPath:input];

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  // The dictionary form rather than the iOS 15 CIRAWFilter class, so this
  // builds against the SDKs the project already targets. Vendor lens
  // correction is left at its default: where Apple has Canon's data for the
  // lens it applies it, and the chromatic aberration measurement downstream
  // reports what is left either way.
  CIFilter *rawFilter = [CIFilter filterWithImageURL:url options:@{}];
#pragma clang diagnostic pop

  if ( !rawFilter ) {
    resolve( @{ @"decoded": @NO, @"reason": @"no raw decoder for this file" } );
    return;
  }
  CIImage *decoded = rawFilter.outputImage;
  if ( !decoded || CGRectIsEmpty( decoded.extent ) || CGRectIsInfinite( decoded.extent ) ) {
    resolve( @{ @"decoded": @NO, @"reason": @"raw decoder produced no image" } );
    return;
  }

  // Scaled before rendering, so the render never materializes the whole
  // 32-megapixel frame.
  CGRect  extent = decoded.extent;
  CGFloat longest = MAX( extent.size.width, extent.size.height );
  CGFloat scale = ( longest > [maxPixel floatValue] && longest > 0 )
    ? [maxPixel floatValue] / longest
    : 1.0;
  if ( scale < 1.0 ) {
    decoded = [decoded imageByApplyingTransform:CGAffineTransformMakeScale( scale, scale )];
    extent = decoded.extent;
  }

  CIContext  *context = [CIContext contextWithOptions:nil];
  CGImageRef  cg      = [context createCGImage:decoded fromRect:extent];
  if ( !cg ) {
    resolve( @{ @"decoded": @NO, @"reason": @"raw render produced no image" } );
    return;
  }

  // The photo keeps the metadata the raw carried: the pixels come from the
  // sensor, everything else from the file.
  CGImageSourceRef src     = CGImageSourceCreateWithURL( (__bridge CFURLRef)url, nil );
  NSDictionary    *srcMeta = nil;
  if ( src ) {
    srcMeta = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex( src, 0, nil );
    CFRelease( src );
  }
  NSInteger width  = (NSInteger)round( extent.size.width );
  NSInteger height = (NSInteger)round( extent.size.height );
  NSData   *data   = jpegDataFromCroppedImage( cg, srcMeta, width, height );
  CGImageRelease( cg );
  if ( !data ) {
    resolve( @{ @"decoded": @NO, @"reason": @"could not encode the decoded raw" } );
    return;
  }

  [[NSFileManager defaultManager]
    createDirectoryAtPath:[output stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];
  if ( ![data writeToFile:output atomically:YES] ) {
    reject( @"RAW_DECODE_FAILED", @"Could not write the decoded raw", nil );
    return;
  }

  resolve( @{
    @"decoded":    @YES,
    @"outputPath": output,
    @"width":      @( width ),
    @"height":     @( height ),
    @"ms":         @( (int)round( ( [NSDate timeIntervalSinceReferenceDate] - started ) * 1000 ) ),
  } );
}

// ─── Lateral chromatic aberration ────────────────────────────────────────────
//
// Lateral CA is the red and blue channels landing at slightly the wrong radius
// from the optical axis, so every high-contrast edge picks up a coloured
// fringe. There is no lens profile to correct it from: the photos arrive from
// any camera, and a raw file's own correction tables are undocumented. So the
// shift is measured from the photo itself, with green as the reference. For
// each ring of the frame we solve for the radial displacement d that best
// explains the difference between the other channel and green over that ring's
// strongest edges,
//
//   C - G  ≈  -d · dG/dr
//
// and keep the answer per ring rather than fitting a line through them. A line
// is the wrong shape for real lenses: on an RF-S 18-150 at 150mm the red shift
// peaks around 0.8px at mid-frame and comes back to 0.1px in the corner, and a
// straight fit through that extrapolates to over a pixel of correction in the
// corner — pushing the corners further out of alignment than they started.
//
// Measurement runs on a downscaled copy (displacements are kept as a fraction
// of the corner radius, so the profile applies unchanged at full size) and is
// iterated, because the gradient estimate underestimates displacements beyond
// a pixel and each pass measures what the last one left behind.

static const int    kCAMeasureMaxPixel  = 1024;
static const int    kCABinCount         = 10;
static const int    kCAIterations       = 3;
// Under a sixth of a pixel there is nothing to see, and resampling to remove
// it only costs the photo a little sharpness.
static const double kCAMinShiftPx       = 0.15;
// Real lateral CA is a few pixels at most. A profile past this is the
// measurement having locked onto something else — a subject that fringes on
// its own, or motion between the channels — so leave the photo alone.
static const double kCAMaxShiftFraction = 0.002;   // of the corner radius
// A ring holding almost none of the frame's edges says nothing about the lens;
// its noise must not become a warp.
static const double kCAMinBinWeightFrac = 0.02;
static const size_t kCAMaxPixels        = 60000000;

// Mean of a (2*radius+1) window, run horizontally into tmp then vertically
// into dst.
static void caBoxBlur( const float *src, float *dst, float *tmp, int w, int h, int radius )
{
  if ( radius < 1 ) {
    memcpy( dst, src, (size_t)w * h * sizeof( float ) );
    return;
  }
  for ( int y = 0; y < h; y++ ) {
    const float *row = src + (size_t)y * w;
    float       *out = tmp + (size_t)y * w;
    double       sum = 0;
    int          count = 0;
    for ( int x = 0; x <= radius && x < w; x++ ) { sum += row[x]; count++; }
    for ( int x = 0; x < w; x++ ) {
      out[x] = (float)( sum / count );
      int add = x + radius + 1, drop = x - radius;
      if ( add < w )   { sum += row[add];  count++; }
      if ( drop >= 0 ) { sum -= row[drop]; count--; }
    }
  }
  for ( int x = 0; x < w; x++ ) {
    double sum = 0;
    int    count = 0;
    for ( int y = 0; y <= radius && y < h; y++ ) { sum += tmp[(size_t)y * w + x]; count++; }
    for ( int y = 0; y < h; y++ ) {
      dst[(size_t)y * w + x] = (float)( sum / count );
      int add = y + radius + 1, drop = y - radius;
      if ( add < h )   { sum += tmp[(size_t)add * w + x];  count++; }
      if ( drop >= 0 ) { sum -= tmp[(size_t)drop * w + x]; count--; }
    }
  }
}

// One channel minus its own local mean: keeps the edges, drops the colour
// difference between channels that would otherwise swamp the comparison.
static void caHighPass(
  const uint8_t *rgba, int channel, int w, int h, int radius,
  float *out, float *scratchA, float *scratchB
)
{
  size_t n = (size_t)w * h;
  for ( size_t i = 0; i < n; i++ ) scratchA[i] = (float)rgba[i * 4 + channel];
  caBoxBlur( scratchA, out, scratchB, w, h, radius );
  for ( size_t i = 0; i < n; i++ ) out[i] = scratchA[i] - out[i];
}

// The displacement a profile gives at radius rn (0 at the centre, 1 at the
// corner), interpolated between ring centres and held flat outside them —
// never extrapolated, which is the whole point of measuring per ring.
static double caProfileAt( const double *profile, double rn )
{
  double x = rn * kCABinCount - 0.5;
  if ( x <= 0 ) return profile[0];
  if ( x >= kCABinCount - 1 ) return profile[kCABinCount - 1];
  int    i = (int)x;
  double f = x - i;
  return profile[i] * ( 1 - f ) + profile[i + 1] * f;
}

// Radial displacement of one channel relative to green, per ring, as a
// fraction of the corner radius.
static void caMeasureChannelProfile(
  const float *hpC, const float *hpG, int w, int h, double *profile
)
{
  double cx = ( w - 1 ) / 2.0, cy = ( h - 1 ) / 2.0;
  double rmax = sqrt( cx * cx + cy * cy );
  double num[kCABinCount], den[kCABinCount];
  memset( num, 0, sizeof( num ) );
  memset( den, 0, sizeof( den ) );
  memset( profile, 0, kCABinCount * sizeof( double ) );
  if ( rmax < 1 ) return;

  for ( int y = 1; y < h - 1; y++ ) {
    for ( int x = 1; x < w - 1; x++ ) {
      size_t i  = (size_t)y * w + x;
      double dx = x - cx, dy = y - cy;
      double r  = sqrt( dx * dx + dy * dy );
      if ( r < 1 ) continue;
      double gx = 0.5 * ( hpG[i + 1] - hpG[i - 1] );
      double gy = 0.5 * ( hpG[i + w] - hpG[i - w] );
      double gr = ( gx * dx + gy * dy ) / r;   // green's derivative along the radius
      int    bin = (int)( r / rmax * kCABinCount );
      if ( bin >= kCABinCount ) bin = kCABinCount - 1;
      num[bin] += gr * ( hpC[i] - hpG[i] );
      den[bin] += gr * gr;
    }
  }

  double maxWeight = 0;
  for ( int b = 0; b < kCABinCount; b++ ) maxWeight = MAX( maxWeight, den[b] );
  if ( maxWeight <= 0 ) return;

  BOOL measured[kCABinCount];
  for ( int b = 0; b < kCABinCount; b++ ) {
    measured[b] = ( den[b] >= maxWeight * kCAMinBinWeightFrac );
    profile[b] = measured[b] ? ( -num[b] / den[b] ) / rmax : 0;
  }
  // A ring with too few edges takes the nearest ring that had them, rather
  // than contributing a number made of noise.
  for ( int b = 0; b < kCABinCount; b++ ) {
    if ( measured[b] ) continue;
    for ( int d = 1; d < kCABinCount; d++ ) {
      if ( b - d >= 0 && measured[b - d] )      { profile[b] = profile[b - d]; break; }
      if ( b + d < kCABinCount && measured[b + d] ) { profile[b] = profile[b + d]; break; }
    }
  }
}

// Resamples one channel about the centre so it lands where green does.
static void caResampleChannel(
  const uint8_t *src, uint8_t *dst, int w, int h, int channel, const double *profile
)
{
  double cx = ( w - 1 ) / 2.0, cy = ( h - 1 ) / 2.0;
  double rmax = sqrt( cx * cx + cy * cy );
  if ( rmax < 1 ) return;
  for ( int y = 0; y < h; y++ ) {
    for ( int x = 0; x < w; x++ ) {
      double dx = x - cx, dy = y - cy;
      double r  = sqrt( dx * dx + dy * dy );
      double sx, sy;
      if ( r < 1e-6 ) {
        sx = cx;
        sy = cy;
      } else {
        double shift = caProfileAt( profile, r / rmax ) * rmax;
        double scale = ( r + shift ) / r;
        sx = cx + dx * scale;
        sy = cy + dy * scale;
      }
      if ( sx < 0 ) sx = 0;
      if ( sy < 0 ) sy = 0;
      if ( sx > w - 1 ) sx = w - 1;
      if ( sy > h - 1 ) sy = h - 1;
      int    x0 = (int)sx, y0 = (int)sy;
      int    x1 = ( x0 + 1 < w ) ? x0 + 1 : x0;
      int    y1 = ( y0 + 1 < h ) ? y0 + 1 : y0;
      double fx = sx - x0, fy = sy - y0;
      double v00 = src[( (size_t)y0 * w + x0 ) * 4 + channel];
      double v10 = src[( (size_t)y0 * w + x1 ) * 4 + channel];
      double v01 = src[( (size_t)y1 * w + x0 ) * 4 + channel];
      double v11 = src[( (size_t)y1 * w + x1 ) * 4 + channel];
      double v   = v00 * ( 1 - fx ) * ( 1 - fy ) + v10 * fx * ( 1 - fy )
                 + v01 * ( 1 - fx ) * fy        + v11 * fx * fy;
      dst[( (size_t)y * w + x ) * 4 + channel] = (uint8_t)( v + 0.5 );
    }
  }
}

// Whether a measured profile looks like a lens rather than like the subject.
//
// Lateral CA grows with distance from the optical axis: it is smallest at the
// centre and largest out towards the corners, and it does not change sign on
// the way. A measurement dominated by the photograph instead — a coloured edge
// that happens to sit mid-frame, a subject that fringes on its own — spikes in
// one ring and reads near zero at the corners.
//
// This matters most for a raw file. iOS cannot demosaic a CR3, so what it hands
// back is the preview the camera embedded, and a camera set to correct
// chromatic aberration has already corrected that preview: measuring one finds
// noise where the aberration used to be. On an EOS R7 frame the preview
// measured a 0.97px spike in ring 2 and nothing at all in the outer rings,
// while the same frame's sensor data measured a clean 1.51px profile that held
// out to the corner. Applying the first would warp the photo for nothing.
static BOOL caProfileLooksLikeALens( const double *profile )
{
  double most = 0;
  int    outerStart = ( kCABinCount * 2 ) / 3;
  double outerMost = 0;
  for ( int b = 0; b < kCABinCount; b++ ) {
    most = MAX( most, fabs( profile[b] ) );
    if ( b >= outerStart ) outerMost = MAX( outerMost, fabs( profile[b] ) );
  }
  if ( most <= 0 ) return NO;
  // The corners must carry most of the displacement, not some ring in the
  // middle of the frame.
  if ( outerMost < most * 0.5 ) return NO;
  // And the outer half must not change sign: a real aberration pushes one way.
  int positive = 0, negative = 0;
  for ( int b = kCABinCount / 2; b < kCABinCount; b++ ) {
    if ( profile[b] > 0 ) positive++;
    if ( profile[b] < 0 ) negative++;
  }
  return ( positive == 0 || negative == 0 );
}

// Biggest displacement anywhere in the frame, in pixels.
static double caMaxShiftPx( const double *profile, double cornerRadius )
{
  double most = 0;
  for ( int b = 0; b < kCABinCount; b++ ) most = MAX( most, fabs( profile[b] ) );
  return most * cornerRadius;
}

// Draws an image into a freshly allocated RGBA8 buffer at w x h. drawInRect
// applies the EXIF orientation, so everything downstream works in display
// orientation and the optical centre really is the centre of the buffer.
static uint8_t *caBitmapFromImage( UIImage *image, int w, int h )
{
  UIGraphicsBeginImageContextWithOptions( CGSizeMake( w, h ), YES, 1.0 );
  [image drawInRect:CGRectMake( 0, 0, w, h )];
  UIImage *drawn = UIGraphicsGetImageFromCurrentImageContext( );
  UIGraphicsEndImageContext( );
  if ( !drawn.CGImage ) return NULL;

  uint8_t *buf = (uint8_t *)calloc( (size_t)w * h * 4, 1 );
  if ( !buf ) return NULL;
  CGColorSpaceRef cs  = CGColorSpaceCreateDeviceRGB( );
  CGContextRef    bmp = CGBitmapContextCreate(
    buf, w, h, 8, (size_t)4 * w, cs,
    kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast );
  CGColorSpaceRelease( cs );
  if ( !bmp ) { free( buf ); return NULL; }
  CGContextDrawImage( bmp, CGRectMake( 0, 0, w, h ), drawn.CGImage );
  CGContextRelease( bmp );
  return buf;
}

static CGImageRef caImageFromBitmap( uint8_t *buf, int w, int h )
{
  CGColorSpaceRef cs  = CGColorSpaceCreateDeviceRGB( );
  CGContextRef    bmp = CGBitmapContextCreate(
    buf, w, h, 8, (size_t)4 * w, cs,
    kCGBitmapByteOrder32Big | kCGImageAlphaNoneSkipLast );
  CGColorSpaceRelease( cs );
  if ( !bmp ) return NULL;
  CGImageRef ref = CGBitmapContextCreateImage( bmp );
  CGContextRelease( bmp );
  return ref;
}

// Measures red and blue against green on a downscaled copy, refining over a
// few passes. Returns NO when there was nothing to measure.
static BOOL caMeasureProfiles( UIImage *image, double *redProfile, double *blueProfile )
{
  memset( redProfile,  0, kCABinCount * sizeof( double ) );
  memset( blueProfile, 0, kCABinCount * sizeof( double ) );

  CGFloat longest = MAX( image.size.width, image.size.height );
  double  scale   = ( longest > kCAMeasureMaxPixel ) ? kCAMeasureMaxPixel / longest : 1.0;
  int     w       = (int)round( image.size.width  * scale );
  int     h       = (int)round( image.size.height * scale );
  if ( w < 64 || h < 64 ) return NO;

  uint8_t *base = caBitmapFromImage( image, w, h );
  if ( !base ) return NO;

  size_t   n     = (size_t)w * h;
  uint8_t *work  = (uint8_t *)malloc( n * 4 );
  float   *hpR   = (float *)malloc( n * sizeof( float ) );
  float   *hpG   = (float *)malloc( n * sizeof( float ) );
  float   *hpB   = (float *)malloc( n * sizeof( float ) );
  float   *scrA  = (float *)malloc( n * sizeof( float ) );
  float   *scrB  = (float *)malloc( n * sizeof( float ) );
  BOOL     ok    = ( work && hpR && hpG && hpB && scrA && scrB );

  if ( ok ) {
    int radius = MAX( 2, MIN( w, h ) / 64 );
    for ( int pass = 0; pass < kCAIterations; pass++ ) {
      memcpy( work, base, n * 4 );
      if ( pass > 0 ) {
        caResampleChannel( base, work, w, h, 0, redProfile );
        caResampleChannel( base, work, w, h, 2, blueProfile );
      }
      caHighPass( work, 0, w, h, radius, hpR, scrA, scrB );
      caHighPass( work, 1, w, h, radius, hpG, scrA, scrB );
      caHighPass( work, 2, w, h, radius, hpB, scrA, scrB );

      double passRed[kCABinCount], passBlue[kCABinCount];
      caMeasureChannelProfile( hpR, hpG, w, h, passRed );
      caMeasureChannelProfile( hpB, hpG, w, h, passBlue );
      for ( int b = 0; b < kCABinCount; b++ ) {
        redProfile[b]  += passRed[b];
        blueProfile[b] += passBlue[b];
      }
    }
  }

  free( base ); free( work ); free( hpR ); free( hpG ); free( hpB ); free( scrA ); free( scrB );
  return ok;
}

static NSArray<NSNumber *> *caProfileToArray( const double *profile )
{
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:kCABinCount];
  for ( int b = 0; b < kCABinCount; b++ ) [out addObject:@( profile[b] )];
  return out;
}

// A profile from JS, which is the same ten numbers this module measured.
static BOOL caProfileFromArray( NSArray *array, double *profile )
{
  if ( ![array isKindOfClass:[NSArray class]] || array.count != kCABinCount ) return NO;
  for ( int b = 0; b < kCABinCount; b++ ) {
    id value = array[b];
    if ( ![value isKindOfClass:[NSNumber class]] ) return NO;
    profile[b] = [value doubleValue];
  }
  return YES;
}

// Resamples red and blue by the given profiles and writes the result. The photo
// keeps the metadata it arrived with (GPS, timestamp, camera): the pixels move,
// nothing else about it does.
static BOOL caWriteCorrectedImage(
  UIImage *image, int W, int H, const double *redProfile, const double *blueProfile,
  NSString *input, NSString *output, NSString **failureOut
)
{
  NSURL           *inputURL = [NSURL fileURLWithPath:input];
  CGImageSourceRef src      = CGImageSourceCreateWithURL( (__bridge CFURLRef)inputURL, nil );
  NSDictionary    *srcMeta  = nil;
  if ( src ) {
    srcMeta = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex( src, 0, nil );
    CFRelease( src );
  }

  uint8_t *full = caBitmapFromImage( image, W, H );
  if ( !full ) {
    if ( failureOut ) *failureOut = @"Could not read image pixels";
    return NO;
  }
  uint8_t *corrected = (uint8_t *)malloc( (size_t)W * H * 4 );
  if ( !corrected ) {
    free( full );
    if ( failureOut ) *failureOut = @"Out of memory";
    return NO;
  }
  memcpy( corrected, full, (size_t)W * H * 4 );
  caResampleChannel( full, corrected, W, H, 0, redProfile );
  caResampleChannel( full, corrected, W, H, 2, blueProfile );
  free( full );

  CGImageRef ref  = caImageFromBitmap( corrected, W, H );
  NSData    *data = ref ? jpegDataFromCroppedImage( ref, srcMeta, W, H ) : nil;
  if ( ref ) CGImageRelease( ref );
  free( corrected );
  if ( !data ) {
    if ( failureOut ) *failureOut = @"Could not encode corrected image";
    return NO;
  }

  [[NSFileManager defaultManager]
    createDirectoryAtPath:[output stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];
  if ( ![data writeToFile:output atomically:YES] ) {
    if ( failureOut ) *failureOut = @"Could not write corrected image";
    return NO;
  }
  return YES;
}

// Corrects lateral chromatic aberration in a photo and writes the result to
// outputPath. Resolves with the profile it measured and whether it wrote
// anything: a photo whose fringing is already under a fraction of a pixel is
// left alone rather than resampled (and softened) for nothing.
RCT_EXPORT_METHOD( correctChromaticAberration
                  : ( NSString * )inputPath outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString       *input   = [inputPath  stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString       *output  = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSTimeInterval  started = [NSDate timeIntervalSinceReferenceDate];

  UIImage *image = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { reject( @"CA_FAILED", @"Could not load image", nil ); return; }

  int W = (int)round( image.size.width );
  int H = (int)round( image.size.height );
  if ( W < 64 || H < 64 || (size_t)W * (size_t)H > kCAMaxPixels ) {
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"image size out of range" } );
    return;
  }

  double redProfile[kCABinCount], blueProfile[kCABinCount];
  if ( !caMeasureProfiles( image, redProfile, blueProfile ) ) {
    reject( @"CA_FAILED", @"Could not measure chromatic aberration", nil );
    return;
  }

  // A channel whose profile is not lens-shaped is left alone; the other may
  // still be worth correcting.
  int dropped = 0;
  if ( !caProfileLooksLikeALens( redProfile ) ) {
    memset( redProfile, 0, kCABinCount * sizeof( double ) );
    dropped += 1;
  }
  if ( !caProfileLooksLikeALens( blueProfile ) ) {
    memset( blueProfile, 0, kCABinCount * sizeof( double ) );
    dropped += 1;
  }

  double cornerRadius = sqrt( (double)W * W + (double)H * H ) / 2.0;
  double redPx        = caMaxShiftPx( redProfile,  cornerRadius );
  double bluePx       = caMaxShiftPx( blueProfile, cornerRadius );
  double limitPx      = kCAMaxShiftFraction * cornerRadius;

  if ( redPx > limitPx || bluePx > limitPx ) {
    // Not reported as measured: an implausible profile is one to forget, not
    // to average into the lens's.
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"measurement implausible",
                @"redShiftPx": @( redPx ), @"blueShiftPx": @( bluePx ) } );
    return;
  }
  if ( redPx < kCAMinShiftPx && bluePx < kCAMinShiftPx ) {
    // Nothing worth resampling for, but still a real measurement of this lens:
    // reported as such so the rest of an import can stop measuring.
    resolve( @{ @"applied": @NO, @"measured": @YES,
                @"reason": dropped > 0
                  ? @"no lens-shaped profile"
                  : @"nothing to correct",
                @"redProfile": caProfileToArray( redProfile ),
                @"blueProfile": caProfileToArray( blueProfile ),
                @"redShiftPx": @( redPx ), @"blueShiftPx": @( bluePx ) } );
    return;
  }

  NSString *failure = nil;
  if ( !caWriteCorrectedImage( image, W, H, redProfile, blueProfile,
                               input, output, &failure ) ) {
    reject( @"CA_FAILED", failure, nil );
    return;
  }

  resolve( @{
    @"applied":     @YES,
    @"measured":    @YES,
    @"channelsDropped": @( dropped ),
    @"outputPath":  output,
    @"redProfile":  caProfileToArray( redProfile ),
    @"blueProfile": caProfileToArray( blueProfile ),
    @"redShiftPx":  @( redPx ),
    @"blueShiftPx": @( bluePx ),
    @"ms":          @( (int)round( ( [NSDate timeIntervalSinceReferenceDate] - started ) * 1000 ) ),
  } );
}

// Corrects a photo with a profile measured from other frames of the same lens
// at the same focal length (see chromaticAberration.ts): lateral CA is a
// property of the lens, so a profile measured once holds for every frame it
// took, and most of an import needs no measuring at all. It also covers the
// frames a measurement cannot handle — a photo of open sky has no edges to
// measure and would otherwise go uncorrected.
RCT_EXPORT_METHOD( applyChromaticAberration
                  : ( NSString * )inputPath outputPath
                  : ( NSString * )outputPath redProfileIn
                  : ( NSArray * )redProfileIn blueProfileIn
                  : ( NSArray * )blueProfileIn resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString       *input   = [inputPath  stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString       *output  = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSTimeInterval  started = [NSDate timeIntervalSinceReferenceDate];

  double redProfile[kCABinCount], blueProfile[kCABinCount];
  if ( !caProfileFromArray( redProfileIn, redProfile )
       || !caProfileFromArray( blueProfileIn, blueProfile ) ) {
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"profile not usable" } );
    return;
  }

  UIImage *image = [UIImage imageWithContentsOfFile:input];
  if ( !image ) { reject( @"CA_FAILED", @"Could not load image", nil ); return; }

  int W = (int)round( image.size.width );
  int H = (int)round( image.size.height );
  if ( W < 64 || H < 64 || (size_t)W * (size_t)H > kCAMaxPixels ) {
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"image size out of range" } );
    return;
  }

  // The same guards a measured correction gets: a profile is only worth
  // applying on the terms it was worth measuring on.
  double cornerRadius = sqrt( (double)W * W + (double)H * H ) / 2.0;
  double redPx        = caMaxShiftPx( redProfile,  cornerRadius );
  double bluePx       = caMaxShiftPx( blueProfile, cornerRadius );
  double limitPx      = kCAMaxShiftFraction * cornerRadius;
  if ( redPx > limitPx || bluePx > limitPx ) {
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"profile implausible" } );
    return;
  }
  if ( redPx < kCAMinShiftPx && bluePx < kCAMinShiftPx ) {
    resolve( @{ @"applied": @NO, @"measured": @NO, @"reason": @"nothing to correct",
                @"redShiftPx": @( redPx ), @"blueShiftPx": @( bluePx ) } );
    return;
  }

  NSString *failure = nil;
  if ( !caWriteCorrectedImage( image, W, H, redProfile, blueProfile,
                               input, output, &failure ) ) {
    reject( @"CA_FAILED", failure, nil );
    return;
  }

  resolve( @{
    @"applied":     @YES,
    @"measured":    @NO,
    @"outputPath":  output,
    @"redShiftPx":  @( redPx ),
    @"blueShiftPx": @( bluePx ),
    @"ms":          @( (int)round( ( [NSDate timeIntervalSinceReferenceDate] - started ) * 1000 ) ),
  } );
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
    PHFetchResult<PHAsset *> *contextFetched = ids.count > 0
      ? [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil]
      : nil;
    NSUInteger fetchedCount = contextFetched.count;
    NSString *assetSummary = contextFetched
      ? inatAssetDeletabilitySummary( contextFetched )
      : @"(nothing fetched)";

    // Whether PhotoKit has taken the deletion's transaction at all, and how
    // long it has been holding it. "transaction=idle" on a hang means the
    // deletion never got as far as issuing one.
    NSString *walk = self->_deleteTransactionActive
      ? [NSString stringWithFormat:
          @"transaction=active count=%lu ms=%.0f",
          ( unsigned long )self->_deleteTransactionCount,
          self->_deleteTransactionStartedAt
            ? [[NSDate date] timeIntervalSinceDate:self->_deleteTransactionStartedAt] * 1000
            : -1]
      : @"transaction=idle";

    NSString *info = [NSString stringWithFormat:
      @"appState=%ld hasWindowScene=%d sceneState=%ld fgActiveScenes=%lu authStatus=%ld "
      @"windows=%lu requested=%lu fetched=%lu %@ %@ outstanding=%@ vcChain=%@ windowList=[%@]",
      ( long )UIApplication.sharedApplication.applicationState,
      hasScene, sceneState, ( unsigned long )foregroundActiveScenes, auth,
      ( unsigned long )UIApplication.sharedApplication.windows.count,
      ( unsigned long )ids.count, ( unsigned long )fetchedCount, assetSummary,
      // Which transaction the library still owes us, if any. The line above
      // only covers deletions; a location write that never came back is the
      // other way in, and nothing reported it.
      walk, inatOutstandingPhotoWriteLabelCopy( ) ?: @"none",
      vcChain, [self inatWindowInventory]];
    resolve( info );
  } );
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

// Two measurements on the assets a deletion is stuck on, run deliberately from
// the cleanup screen rather than during a delete.
//
// Everything cheap is used up: the assets are ordinary and deletable, a bare
// CameraRoll.deletePhotos hangs the same way, the consent-free half hangs too,
// Recently Deleted has been emptied, and updateAssetLocations — the same
// performChanges API from the same process — still writes in ~100ms. Two
// possibilities remain and no log line separates them: PhotoKit is asking for
// a confirmation that never appears, or deleteAssets is not getting that far.
//
// So ask both questions directly:
//
// 1. A no-op modify transaction on one of the stuck assets — its own isFavorite
//    written back unchanged. Same performChanges, same asset, same consent
//    rules; only the operation differs. If it comes back quickly, PhotoKit is
//    servicing writes on this exact asset and the fault is specific to
//    deleteAssets. If it hangs too, the consent path is what's broken and
//    deletion is only where it shows.
//
// 2. Whether this app can present a UIAlertController at all, right now, from
//    the same view controller PhotoKit's confirmation would use. If ours
//    appears and PhotoKit's never does, PhotoKit isn't asking.
RCT_EXPORT_METHOD( photoDeleteProbe
                  : ( NSArray<NSString *> * )phUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for ( NSString *u in ( phUris ?: @[] ) ) {
      [ids addObject:( [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u )];
    }
    PHAsset *asset = ids.count > 0
      ? [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil].firstObject
      : nil;
    if ( !asset ) {
      resolve( @"no asset to probe" );
      return;
    }

    __block BOOL answered = NO;
    __block NSString *modifyResult = @"still outstanding";
    NSDate *startedAt = [NSDate date];

    // Runs the presentation test, then answers. Whichever of the modify
    // transaction and its watchdog gets here first is the one that reports.
    void ( ^finishProbe )( void ) = ^{
      if ( answered ) { return; }
      answered = YES;
      UIWindow *keyWindow = [self inatKeyWindow];
      UIViewController *presenter = keyWindow.rootViewController;
      while ( presenter.presentedViewController ) {
        presenter = presenter.presentedViewController;
      }
      if ( !presenter ) {
        resolve( [NSString stringWithFormat:@"modify=%@ ownAlert=no-view-controller",
          modifyResult] );
        return;
      }
      UIAlertController *probe =
        [UIAlertController alertControllerWithTitle:@"Checking Photos"
                                            message:nil
                                     preferredStyle:UIAlertControllerStyleAlert];
      [presenter presentViewController:probe animated:NO completion:nil];
      // A beat for UIKit to put it up, then read whether it actually did.
      dispatch_after(
        dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( 0.5 * NSEC_PER_SEC ) ),
        dispatch_get_main_queue(),
        ^{
          BOOL presented = presenter.presentedViewController == probe;
          [probe dismissViewControllerAnimated:NO completion:nil];
          resolve( [NSString stringWithFormat:@"modify=%@ ownAlert=%@ presenter=%@",
            modifyResult,
            presented
              ? @"presented"
              : @"refused",
            NSStringFromClass( [presenter class] )] );
        } );
    };

    NSUInteger writeToken = inatPhotoWriteBegan( @"photoDeleteProbe(modify)" );
    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      PHAssetChangeRequest *request = [PHAssetChangeRequest changeRequestForAsset:asset];
      // Its own value written back: a transaction that changes nothing, and
      // asks for exactly the consent a real modification would.
      request.favorite = asset.isFavorite;
    } completionHandler:^( BOOL success, NSError *error ) {
      inatPhotoWriteEnded( writeToken );
      NSInteger ms = ( NSInteger )( [[NSDate date] timeIntervalSinceDate:startedAt] * 1000 );
      modifyResult = success
        ? [NSString stringWithFormat:@"ok-in-%ldms", ( long )ms]
        : [NSString stringWithFormat:@"failed-in-%ldms:%@", ( long )ms,
            error.localizedDescription ?: @"unknown"];
      dispatch_async( dispatch_get_main_queue(), finishProbe );
    }];

    // The modify transaction can hang exactly like the deletion does, and that
    // is itself the answer — so don't wait on it forever to report.
    dispatch_after(
      dispatch_time( DISPATCH_TIME_NOW, ( int64_t )( 20 * NSEC_PER_SEC ) ),
      dispatch_get_main_queue(),
      finishProbe );
  } );
}

// How many assets a hang reports in detail. Enough to see whether the stuck
// batch is all one kind of photo; few enough to stay one readable log line.
static const NSUInteger kInatAssetDiagnosticLimit = 8;

// A per-asset dossier for the photos a deletion is stuck on, and the device it
// is stuck on. Fired only from a hang, so it costs nothing on a working
// deletion.
//
// The cheap explanations are used up. The Aug 26 log's ten stuck assets are
// userLibrary, PhotoKit says every one of them can be deleted, and the
// transaction still neither presents its confirmation nor calls back. What
// separates them from the hundreds that did delete isn't in anything logged so
// far — and the cutover is a date, not a batch: every prompted transaction
// through Aug 25 04:03 worked, every one since has hung, one of them carrying
// a single photo. That points at the device rather than at the request, which
// is why the OS and model are in here and why this exists at all.
RCT_EXPORT_METHOD( photoAssetDiagnostics
                  : ( NSArray<NSString *> * )phUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSMutableArray<NSString *> *ids = [NSMutableArray array];
    for ( NSString *u in ( phUris ?: @[] ) ) {
      [ids addObject:( [u hasPrefix:@"ph://"] ? [u substringFromIndex:5] : u )];
    }
    PHFetchResult<PHAsset *> *fetched = ids.count > 0
      ? [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil]
      : nil;

    NSDateFormatter *day = [[NSDateFormatter alloc] init];
    day.dateFormat = @"yyyy-MM-dd";
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    NSUInteger reported = 0;
    for ( PHAsset *asset in ( fetched ?: ( id )@[] ) ) {
      if ( reported >= kInatAssetDiagnosticLimit ) { break; }
      reported += 1;
      // The resource types and UTIs say what the photo actually is — a plain
      // JPEG, a RAW the app imported off a card, one half of a live photo.
      NSMutableArray<NSString *> *resources = [NSMutableArray array];
      for ( PHAssetResource *resource in [PHAssetResource assetResourcesForAsset:asset] ) {
        [resources addObject:[NSString stringWithFormat:@"%ld/%@",
          ( long )resource.type, resource.uniformTypeIdentifier ?: @"?"]];
      }
      [lines addObject:[NSString stringWithFormat:
        @"{media=%ld sub=%lu %ldx%ld created=%@ hidden=%d fave=%d burst=%d "
        @"canDelete=%d canEditContent=%d res=[%@]}",
        ( long )asset.mediaType, ( unsigned long )asset.mediaSubtypes,
        ( long )asset.pixelWidth, ( long )asset.pixelHeight,
        asset.creationDate
          ? [day stringFromDate:asset.creationDate]
          : @"?",
        asset.isHidden, asset.isFavorite, asset.representsBurst,
        [asset canPerformEditOperation:PHAssetEditOperationDelete],
        [asset canPerformEditOperation:PHAssetEditOperationContent],
        [resources componentsJoinedByString:@" "]]];
    }

    struct utsname systemInfo;
    uname( &systemInfo );
    resolve( [NSString stringWithFormat:@"os=%@ model=%s requested=%lu fetched=%lu %@",
      UIDevice.currentDevice.systemVersion, systemInfo.machine,
      ( unsigned long )ids.count, ( unsigned long )fetched.count,
      [lines componentsJoinedByString:@" "]] );
  } );
}

// Best-effort device-photo deletion. Dismisses any modal presented over the
// root VC first (iOS won't present its deletion confirmation over a modal),
// then requests deletion. Rejects with requested/fetched counts so JS can tell
// whether the identifiers resolved to real assets.
//
// Everything goes out in one transaction — see the note beside doDelete below
// for why the app-created assets no longer get one of their own.
RCT_EXPORT_METHOD( deletePhotoAssets
                  : ( NSArray<NSString *> * )phUris resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    NSString *busy = inatOutstandingPhotoWrite( );
    if ( busy ) {
      reject( @"PHOTOS_LIBRARY_BUSY", busy, nil );
      return;
    }

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

    // Anything PhotoKit says this app cannot delete is left out of the
    // transaction entirely. Including one doesn't make the deletion slow, it
    // makes it silent: no confirmation, no completion handler, and the assets
    // it was batched with never get deleted either, because a transaction is
    // all or nothing. Reported either way, so the log says which kind of asset
    // a cleanup is stuck on instead of only that it is stuck.
    NSString *assetSummary = inatAssetDeletabilitySummary( fetched );
    NSMutableArray<PHAsset *> *deletable = [NSMutableArray array];
    NSUInteger undeletable = 0;
    for ( PHAsset *asset in fetched ) {
      if ( [asset canPerformEditOperation:PHAssetEditOperationDelete] ) {
        [deletable addObject:asset];
      } else {
        undeletable += 1;
      }
    }
    if ( deletable.count == 0 ) {
      resolve( @{
        @"deleted": @0,
        @"requested": @( ids.count ),
        @"fetched": @( fetched.count ),
        @"undeletable": @( undeletable ),
        @"assets": assetSummary,
      } );
      return;
    }

    // Only reported, not acted on: a transaction that carries an asset this
    // app did not create is one PhotoKit will ask the user about, and knowing
    // that about a hung deletion is worth a line in the log.
    NSMutableArray<PHAsset *> *ourAssets = [NSMutableArray array];
    for ( PHAsset *asset in deletable ) {
      if ( [asset canPerformEditOperation:PHAssetEditOperationContent]
          && asset.sourceType == PHAssetSourceTypeUserLibrary ) {
        // Nothing public distinguishes an asset this app added from any other
        // in the user's library, so this is the closest honest answer: it is
        // ours to edit. See appCreatedPhotoAssets.ts for the identifiers the
        // JS side records at creation time.
        [ourAssets addObject:asset];
      }
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
    // A prompted transaction that never came back leaves this set; clear it
    // here so a later hang can't be misread as that one still being in flight.
    _deleteTransactionActive = NO;
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
        // A transaction whose completion handler never fires can still have
        // done the work, and a change notification can be missed (coalesced,
        // or delivered before the observer was registered). Ask the library
        // directly before calling this a failure: rejecting a deletion that
        // landed is what left the write gate shut against a library that was
        // answering perfectly well, which refused every later write in the
        // session in milliseconds — the "it failed immediately" the Aug 24 and
        // Aug 25 logs end on.
        PHFetchResult<PHAsset *> *stillPresent =
          [PHAsset fetchAssetsWithLocalIdentifiers:ids options:nil];
        BOOL landed = stillPresent.count == 0;
        if ( !claimSettlement( ) ) { return; }
        if ( landed ) {
          inatPhotoWriteEnded( 0 );
          self->_deleteTransactionActive = NO;
          resolve( @{
            @"deleted": @( fetched.count ),
            @"requested": @( ids.count ),
            @"viaWatchdogFetch": @YES,
          } );
          return;
        }
        reject( @"DELETE_NO_CALLBACK",
          [NSString stringWithFormat:
            @"deleteAssets for %lu asset(s) never called back in %.0fs "
            @"(%lu still in the library; %@)",
            ( unsigned long )ids.count, kInatPendingDeleteWatchdogSeconds,
            ( unsigned long )stillPresent.count,
            inatAssetDeletabilitySummary( stillPresent )],
          nil );
      } );

    // One transaction, whatever the batch holds.
    //
    // Deletions used to go out as two: the assets this app added to the library
    // itself, which PhotoKit deletes without presenting its confirmation, and
    // then everything else. That bought nothing. A confirmation appears when a
    // transaction carries an asset the app does not own, so a mixed batch asked
    // the user once either way, and a batch that is all ours still asks nothing
    // when it goes out whole. What the split did cost was a deadlock: the
    // second transaction was issued from the first's completion handler, and
    // when that handler never fired the photos needing consent were never
    // requested at all — see the Aug 26 log, three app-created assets deleted
    // and nine never asked for.
    __block NSInteger transactionMs = -1;
    __block NSUInteger transactionDeleted = 0;

    void ( ^finish )( BOOL, NSError * ) = ^( BOOL success, NSError *error ) {
      dispatch_async( dispatch_get_main_queue(), ^{
        if ( !claimSettlement( ) ) { return; }
        if ( success ) {
          resolve( @{
            @"deleted": @( transactionDeleted ),
            @"requested": @( ids.count ),
            @"dismissedModal": @( dismissedModal ),
            @"sceneState": @( sceneState ),
            @"viaChangeObserver": @NO,
            @"appCreated": @( ourAssets.count ),
            @"transactionMs": @( transactionMs ),
            @"undeletable": @( undeletable ),
            @"assets": assetSummary,
          } );
        } else {
          reject( @"DELETE_FAILED",
            [NSString stringWithFormat:
              @"requested=%lu fetched=%lu appCreated=%lu transactionMs=%ld "
              @"dismissedModal=%d sceneState=%ld assets=[%@] error=%@",
              ( unsigned long )ids.count, ( unsigned long )fetched.count,
              ( unsigned long )ourAssets.count, ( long )transactionMs,
              dismissedModal, sceneState, assetSummary,
              error.localizedDescription ?: @"unknown"],
            error );
        }
      } );
    };

    void ( ^doDelete )( void ) = ^{
      NSDate *startedAt = [NSDate date];
      self->_deleteTransactionActive = YES;
      self->_deleteTransactionCount = deletable.count;
      self->_deleteTransactionStartedAt = startedAt;
      NSUInteger writeToken = inatPhotoWriteBegan(
        [NSString stringWithFormat:@"deleteAssets(%lu)",
          ( unsigned long )deletable.count] );
      [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
        [PHAssetChangeRequest deleteAssets:deletable];
      } completionHandler:^( BOOL success, NSError *error ) {
        inatPhotoWriteEnded( writeToken );
        transactionMs =
          ( NSInteger )( [[NSDate date] timeIntervalSinceDate:startedAt] * 1000 );
        self->_deleteTransactionActive = NO;
        // A transaction deletes all of its assets or none of them, including
        // when the user simply declines the confirmation.
        if ( success ) { transactionDeleted = deletable.count; }
        finish( success, error );
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
    // The requested assets are gone, so the transaction did land whatever its
    // completion handler is doing. Clear the write gate: a library that just
    // carried out a deletion is answering, and holding the gate shut on the
    // strength of a callback that will never arrive would refuse every write
    // for the rest of the session.
    inatPhotoWriteEnded( 0 );
    self->_deleteTransactionActive = NO;
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
