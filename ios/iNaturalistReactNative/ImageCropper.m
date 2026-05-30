#import <ImageIO/ImageIO.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>

@interface ImageCropper : NSObject <RCTBridgeModule>
@end

@implementation ImageCropper

RCT_EXPORT_MODULE( );

static CGImagePropertyOrientation orientationFromUIImage( UIImage *image )
{
  switch ( image.imageOrientation ) {
    case UIImageOrientationUp:
      return kCGImagePropertyOrientationUp;
    case UIImageOrientationDown:
      return kCGImagePropertyOrientationDown;
    case UIImageOrientationLeft:
      return kCGImagePropertyOrientationLeft;
    case UIImageOrientationRight:
      return kCGImagePropertyOrientationRight;
    case UIImageOrientationUpMirrored:
      return kCGImagePropertyOrientationUpMirrored;
    case UIImageOrientationDownMirrored:
      return kCGImagePropertyOrientationDownMirrored;
    case UIImageOrientationLeftMirrored:
      return kCGImagePropertyOrientationLeftMirrored;
    case UIImageOrientationRightMirrored:
      return kCGImagePropertyOrientationRightMirrored;
    default:
      return kCGImagePropertyOrientationUp;
  }
}

static NSDictionary *normalizedBoundsFromVisionRect( CGRect rect )
{
  if ( rect.size.width <= 0 || rect.size.height <= 0 ) {
    return nil;
  }

  CGFloat x = rect.origin.x;
  CGFloat y = 1.0 - rect.origin.y - rect.size.height;
  CGFloat width = rect.size.width;
  CGFloat height = rect.size.height;

  return @{
    @"x": @( x ),
    @"y": @( y ),
    @"width": @( width ),
    @"height": @( height ),
  };
}

static CGRect unionVisionRect( CGRect existing, CGRect next, BOOL hasExisting )
{
  if ( !hasExisting ) {
    return next;
  }

  CGFloat minX = MIN( existing.origin.x, next.origin.x );
  CGFloat minY = MIN( existing.origin.y, next.origin.y );
  CGFloat maxX = MAX( existing.origin.x + existing.size.width, next.origin.x + next.size.width );
  CGFloat maxY = MAX( existing.origin.y + existing.size.height, next.origin.y + next.size.height );

  return CGRectMake( minX, minY, maxX - minX, maxY - minY );
}

static NSDictionary *detectSubjectBoundsUnionAll( VNImageRequestHandler *handler )
{
  NSMutableArray<VNRequest *> *requests = [NSMutableArray array];

  VNDetectHumanRectanglesRequest *humanRequest = [[VNDetectHumanRectanglesRequest alloc] init];
  [requests addObject:humanRequest];

  VNRecognizeAnimalsRequest *animalRequest = nil;
  if ( @available( iOS 15.0, * ) ) {
    animalRequest = [[VNRecognizeAnimalsRequest alloc] init];
    [requests addObject:animalRequest];
  }

  VNGenerateAttentionBasedSaliencyImageRequest *saliencyRequest =
    [[VNGenerateAttentionBasedSaliencyImageRequest alloc] init];
  [requests addObject:saliencyRequest];

  NSError *error = nil;
  if ( ![handler performRequests:requests error:&error] ) {
    return nil;
  }

  CGRect unionRect = CGRectZero;
  BOOL hasUnion = NO;

  for ( VNHumanObservation *observation in humanRequest.results ) {
    unionRect = unionVisionRect( unionRect, observation.boundingBox, hasUnion );
    hasUnion = YES;
  }

  if ( @available( iOS 15.0, * ) ) {
    for ( VNRecognizedObjectObservation *observation in animalRequest.results ) {
      if ( observation.confidence < 0.3 ) {
        continue;
      }
      unionRect = unionVisionRect( unionRect, observation.boundingBox, hasUnion );
      hasUnion = YES;
    }
  }

  for ( VNSaliencyImageObservation *observation in saliencyRequest.results ) {
    for ( VNRectangleObservation *salientObject in observation.salientObjects ) {
      unionRect = unionVisionRect( unionRect, salientObject.boundingBox, hasUnion );
      hasUnion = YES;
    }
  }

  if ( !hasUnion ) {
    return nil;
  }

  return normalizedBoundsFromVisionRect( unionRect );
}

static NSDictionary *detectSubjectBoundsForImage( UIImage *image )
{
  if ( image.CGImage == NULL ) {
    return nil;
  }

  CGImagePropertyOrientation orientation = orientationFromUIImage( image );
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image.CGImage
                                                                      orientation:orientation
                                                                          options:@{}];

  return detectSubjectBoundsUnionAll( handler );
}

static void updateMetadataForCrop( NSMutableDictionary *metadata, NSInteger width, NSInteger height )
{
  metadata[(NSString *)kCGImagePropertyPixelWidth] = @( width );
  metadata[(NSString *)kCGImagePropertyPixelHeight] = @( height );
  metadata[(NSString *)kCGImagePropertyOrientation] = @( 1 );

  NSString *exifKey = (__bridge NSString *)kCGImagePropertyExifDictionary;
  NSMutableDictionary *exif = [[metadata[exifKey] mutableCopy] ?: @{} mutableCopy];
  exif[(NSString *)kCGImagePropertyExifPixelXDimension] = @( width );
  exif[(NSString *)kCGImagePropertyExifPixelYDimension] = @( height );
  metadata[exifKey] = exif;

  NSString *tiffKey = (__bridge NSString *)kCGImagePropertyTIFFDictionary;
  NSMutableDictionary *tiff = [[metadata[tiffKey] mutableCopy] ?: @{} mutableCopy];
  tiff[@"ImageWidth"] = @( width );
  tiff[@"ImageLength"] = @( height );
  tiff[(NSString *)kCGImagePropertyTIFFOrientation] = @( 1 );
  metadata[tiffKey] = tiff;
}

static NSData *jpegDataFromCroppedImage(
  CGImageRef croppedRef,
  NSDictionary *sourceMetadata,
  NSInteger width,
  NSInteger height
)
{
  NSMutableDictionary *metadata = sourceMetadata
    ? [sourceMetadata mutableCopy]
    : [NSMutableDictionary dictionary];
  updateMetadataForCrop( metadata, width, height );
  metadata[(NSString *)kCGImageDestinationLossyCompressionQuality] = @( 1.0 );

  NSMutableData *destinationData = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData(
    (__bridge CFMutableDataRef)destinationData,
    CFSTR( "public.jpeg" ),
    1,
    nil
  );
  if ( destination == NULL ) {
    return nil;
  }

  CGImageDestinationAddImage( destination, croppedRef, (__bridge CFDictionaryRef)metadata );
  BOOL finalized = CGImageDestinationFinalize( destination );
  CFRelease( destination );

  return finalized ? destinationData : nil;
}

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
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://"
                                                           withString:@""];
  NSString *output = [outputPath stringByReplacingOccurrencesOfString:@"file://"
                                                            withString:@""];
  NSURL *inputURL = [NSURL fileURLWithPath:input];
  CGImageSourceRef imageSource = CGImageSourceCreateWithURL( (__bridge CFURLRef)inputURL, nil );
  NSDictionary *sourceMetadata = nil;
  if ( imageSource != NULL ) {
    sourceMetadata = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex(
      imageSource,
      0,
      nil
    );
    CFRelease( imageSource );
  }

  UIImage *image = [UIImage imageWithContentsOfFile:input];
  if ( image == nil ) {
    reject( @"CROP_FAILED", @"Could not load image", nil );
    return;
  }

  CGRect cropRect = CGRectMake(
    [originX integerValue],
    [originY integerValue],
    [width integerValue],
    [height integerValue]
  );

  CGImageRef croppedRef = CGImageCreateWithImageInRect( image.CGImage, cropRect );
  if ( croppedRef == NULL ) {
    reject( @"CROP_FAILED", @"Crop failed", nil );
    return;
  }

  NSInteger cropWidth = [width integerValue];
  NSInteger cropHeight = [height integerValue];
  NSData *data = jpegDataFromCroppedImage(
    croppedRef,
    sourceMetadata,
    cropWidth,
    cropHeight
  );
  CGImageRelease( croppedRef );

  if ( data == nil ) {
    reject( @"CROP_FAILED", @"Could not encode cropped image", nil );
    return;
  }

  [[NSFileManager defaultManager] createDirectoryAtPath:[output stringByDeletingLastPathComponent]
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  if ( ![data writeToFile:output atomically:YES] ) {
    reject( @"CROP_FAILED", @"Could not write cropped image", nil );
    return;
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
  NSString *source = [sourcePath stringByReplacingOccurrencesOfString:@"file://"
                                                             withString:@""];
  NSString *dest = [destPath stringByReplacingOccurrencesOfString:@"file://"
                                                        withString:@""];
  NSURL *sourceURL = [NSURL fileURLWithPath:source];
  CGImageSourceRef imageSource = CGImageSourceCreateWithURL( (__bridge CFURLRef)sourceURL, nil );
  NSDictionary *sourceMetadata = nil;
  if ( imageSource != NULL ) {
    sourceMetadata = (__bridge_transfer NSDictionary *)CGImageSourceCopyPropertiesAtIndex(
      imageSource,
      0,
      nil
    );
    CFRelease( imageSource );
  }

  UIImage *croppedImage = [UIImage imageWithContentsOfFile:dest];
  if ( croppedImage == nil ) {
    reject( @"CROP_FAILED", @"Could not load cropped image", nil );
    return;
  }

  CGImageRef croppedRef = croppedImage.CGImage;
  if ( croppedRef == NULL ) {
    reject( @"CROP_FAILED", @"Could not read cropped image", nil );
    return;
  }

  NSInteger cropWidth = [width integerValue];
  NSInteger cropHeight = [height integerValue];
  NSData *data = jpegDataFromCroppedImage(
    croppedRef,
    sourceMetadata,
    cropWidth,
    cropHeight
  );

  if ( data == nil ) {
    reject( @"CROP_FAILED", @"Could not encode cropped image with metadata", nil );
    return;
  }

  if ( ![data writeToFile:dest atomically:YES] ) {
    reject( @"CROP_FAILED", @"Could not write cropped image", nil );
    return;
  }

  resolve( dest );
}

RCT_EXPORT_METHOD( detectSubjectBounds
                  : ( NSString * )inputPath model
                  : ( NSString * )model resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *input = [inputPath stringByReplacingOccurrencesOfString:@"file://"
                                                           withString:@""];
  UIImage *image = [UIImage imageWithContentsOfFile:input];
  if ( image == nil ) {
    resolve( [NSNull null] );
    return;
  }

  NSString *modelId = model.length > 0 ? model : @"A";
  (void)modelId;
  NSDictionary *bounds = detectSubjectBoundsForImage( image );
  if ( bounds == nil ) {
    resolve( [NSNull null] );
    return;
  }

  resolve( bounds );
}

@end
