// Runs the Video Stabilizer's FFT tile analysis outside the app, on macOS.
// The registration code isn't copied: the workflow cuts the block between
// BEGIN and END FFT REGISTRATION out of ios/iNaturalistReactNative/
// VideoStabilizer.m into fft_block.inc, so this measures exactly what ships.
// Frames are read and scaled the way the app's analyze() does it.
#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreImage/CoreImage.h>

#include "fft_block.inc"

static NSArray *tiles( double shifts[][2], const BOOL *found )
{
  NSMutableArray *out = [NSMutableArray array];
  for ( int k = 0; k < kTileCount; k++ ) {
    [out addObject:found[k] ? @[@( shifts[k][0] ), @( shifts[k][1] )] : (id)[NSNull null]];
  }
  return out;
}

int main( int argc, const char *argv[] )
{
  @autoreleasepool {
    if ( argc < 2 ) return 2;
    CIContext *ctx = [CIContext contextWithOptions:@{ kCIContextCacheIntermediates: @NO }];
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:@( argv[1] )] options:nil];
    NSArray<AVAssetTrack *> *tracks = [asset tracksWithMediaType:AVMediaTypeVideo];
    AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:asset error:nil];
    AVMutableVideoComposition *composition = [AVMutableVideoComposition videoCompositionWithPropertiesOfAsset:asset];
    double fps = MIN( tracks.firstObject.nominalFrameRate > 0 ? tracks.firstObject.nominalFrameRate : 30, 60 );
    composition.frameDuration = CMTimeMake( 1000, (int32_t)round( fps * 1000 ) );
    AVAssetReaderVideoCompositionOutput *output = [AVAssetReaderVideoCompositionOutput
      assetReaderVideoCompositionOutputWithVideoTracks:tracks
                                         videoSettings:@{
                                           (id)kCVPixelBufferPixelFormatTypeKey: @( kCVPixelFormatType_32BGRA ),
                                           (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                                         }];
    output.videoComposition = composition;
    output.alwaysCopiesSampleData = NO;
    [reader addOutput:output];
    if ( ![reader startReading] ) {
      fprintf( stderr, "cannot read %s\n", argv[1] );
      return 1;
    }
    NSMutableArray *frames = [NSMutableArray array];
    CVPixelBufferPoolRef pool = NULL;
    GrayImage gray = { NULL, 0, 0 };
    Tracker tracker;
    memset( &tracker, 0, sizeof( tracker ) );
    FrameMeasure *measure = calloc( 1, sizeof( FrameMeasure ) );
    double scale = 1;
    int width = 0;
    int height = 0;
    double measureSeconds = 0;
    NSDate *start = [NSDate date];
    while ( YES ) {
      @autoreleasepool {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if ( !sample ) break;
        CVPixelBufferRef full = CMSampleBufferGetImageBuffer( sample );
        double t = CMTimeGetSeconds( CMSampleBufferGetPresentationTimeStamp( sample ) );
        if ( !pool ) {
          size_t fw = CVPixelBufferGetWidth( full );
          size_t fh = CVPixelBufferGetHeight( full );
          scale = MIN( 1, kRegistrationDimension / MAX( fw, fh ) );
          width = (int)round( fw * scale );
          height = (int)round( fh * scale );
          NSDictionary *attributes = @{
            (id)kCVPixelBufferPixelFormatTypeKey: @( kCVPixelFormatType_32BGRA ),
            (id)kCVPixelBufferWidthKey: @( width ),
            (id)kCVPixelBufferHeightKey: @( height ),
            (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
          };
          CVPixelBufferPoolCreate( NULL, NULL, (__bridge CFDictionaryRef)attributes, &pool );
          gray = grayImageCreate( width, height );
          tracker = trackerCreate( width, height );
        }
        CVPixelBufferRef small = NULL;
        CVPixelBufferPoolCreatePixelBuffer( NULL, pool, &small );
        [ctx render:[[CIImage imageWithCVPixelBuffer:full] imageByApplyingTransform:CGAffineTransformMakeScale( scale, scale )]
          toCVPixelBuffer:small];
        CFRelease( sample );
        grayImageFill( &gray, small );
        CVPixelBufferRelease( small );
        NSDate *m0 = [NSDate date];
        trackerMeasure( &tracker, &gray, measure );
        measureSeconds -= m0.timeIntervalSinceNow;
        [frames addObject:@{
          @"t": @( t ),
          @"ok": @( measure->stepOK ),
          @"rok": @( measure->readingOK ),
          @"step": @[@( measure->stepX ), @( measure->stepY )],
          @"chain": @[@( tracker.chainX ), @( tracker.chainY )],
          @"ts": tiles( measure->stepShifts, measure->stepFound ),
          @"tr": tiles( measure->readingShifts, measure->readingFound ),
        }];
      }
    }
    NSDictionary *result = @{
      @"width": @( width ), @"height": @( height ), @"scale": @( scale ), @"frames": frames,
      @"seconds": @( -start.timeIntervalSinceNow ), @"measureSeconds": @( measureSeconds ),
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    fwrite( json.bytes, 1, json.length, stdout );
    fprintf( stderr, "%s: %lu frames, %.1f s total, %.1f ms per frame measuring\n", argv[1],
      (unsigned long)frames.count, -start.timeIntervalSinceNow, 1000 * measureSeconds / MAX( 1, frames.count ) );
  }
  return 0;
}
