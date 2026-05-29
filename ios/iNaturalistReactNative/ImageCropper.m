#import <ImageIO/ImageIO.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

@interface ImageCropper : NSObject <RCTBridgeModule>
@end

@implementation ImageCropper

RCT_EXPORT_MODULE( );

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

@end
