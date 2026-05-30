#import <AVFoundation/AVFoundation.h>
#import <Photos/Photos.h>
#import <React/RCTBridgeModule.h>

@interface VideoAudioExtractor : NSObject <RCTBridgeModule>
@end

@implementation VideoAudioExtractor

RCT_EXPORT_MODULE( );

- (NSString *)formattedTimestampFromDate:(NSDate *)date
{
  NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
  [formatter setDateFormat:@"yyyy-MM-dd'T'HH:mm:ss.SSSZ"];
  return [formatter stringFromDate:date];
}

- (void)addMetadataFromPHAsset:(PHAsset *)phAsset toMetadata:(NSMutableDictionary *)metadata
{
  if ( phAsset.location != nil ) {
    metadata[@"latitude"] = @( phAsset.location.coordinate.latitude );
    metadata[@"longitude"] = @( phAsset.location.coordinate.longitude );
    if ( phAsset.location.horizontalAccuracy >= 0 ) {
      metadata[@"positional_accuracy"] = @( phAsset.location.horizontalAccuracy );
    }
  }

  if ( phAsset.creationDate != nil ) {
    metadata[@"timestamp"] = [self formattedTimestampFromDate:phAsset.creationDate];
  }
}

- (void)addMetadataFromVideoAsset:(AVURLAsset *)asset toMetadata:(NSMutableDictionary *)metadata
{
  if ( metadata[@"latitude"] != nil && metadata[@"longitude"] != nil ) {
    return;
  }

  for ( AVMetadataItem *item in [AVMetadataItem metadataItemsFromArray:asset.commonMetadata
                                                           withKey:AVMetadataCommonKeyLocation
                                                          keySpace:AVMetadataKeySpaceCommon] ) {
    NSString *locationValue = (NSString *)item.stringValue;
    if ( locationValue == nil ) {
      continue;
    }

    // ISO 6709 format, e.g. "+37.332-122.0301/"
    NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"([+-]?\\d+(?:\\.\\d+)?)([+-]\\d+(?:\\.\\d+)?)"
                                                                           options:0
                                                                             error:nil];
    NSTextCheckingResult *match = [regex firstMatchInString:locationValue
                                                    options:0
                                                      range:NSMakeRange( 0, locationValue.length )];
    if ( match == nil ) {
      continue;
    }

    NSString *latitudeString = [locationValue substringWithRange:[match rangeAtIndex:1]];
    NSString *longitudeString = [locationValue substringWithRange:[match rangeAtIndex:2]];
    metadata[@"latitude"] = @( latitudeString.doubleValue );
    metadata[@"longitude"] = @( longitudeString.doubleValue );
    break;
  }
}

RCT_EXPORT_METHOD( getVideoMetadata
                  : ( NSString * )videoPath assetId
                  : ( NSString * )assetId resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSMutableDictionary *metadata = [NSMutableDictionary new];

  if ( assetId != nil && assetId.length > 0 ) {
    PHFetchResult<PHAsset *> *fetchResult = [PHAsset fetchAssetsWithLocalIdentifiers:@[assetId]
                                                                             options:nil];
    PHAsset *phAsset = fetchResult.firstObject;
    if ( phAsset != nil ) {
      [self addMetadataFromPHAsset:phAsset toMetadata:metadata];
    }
  }

  NSString *normalizedVideoPath = [videoPath stringByReplacingOccurrencesOfString:@"file://"
                                                                       withString:@""];
  NSURL *videoURL = [NSURL fileURLWithPath:normalizedVideoPath];
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:videoURL options:nil];
  [self addMetadataFromVideoAsset:asset toMetadata:metadata];

  resolve( metadata );
}

RCT_EXPORT_METHOD( extractAudio
                  : ( NSString * )videoPath outputPath
                  : ( NSString * )outputPath resolver
                  : ( RCTPromiseResolveBlock )resolve rejecter
                  : ( RCTPromiseRejectBlock )reject )
{
  NSString *normalizedVideoPath = [videoPath stringByReplacingOccurrencesOfString:@"file://"
                                                                       withString:@""];
  NSURL *videoURL = [NSURL fileURLWithPath:normalizedVideoPath];
  NSURL *outputURL = [NSURL fileURLWithPath:outputPath];

  [[NSFileManager defaultManager] removeItemAtURL:outputURL error:nil];

  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:videoURL options:nil];
  AVAssetExportSession *exportSession = [AVAssetExportSession exportSessionWithAsset:asset
                                                                          presetName:AVAssetExportPresetAppleM4A];
  if ( exportSession == nil ) {
    reject( @"EXTRACT_AUDIO_FAILED", @"Could not create audio export session", nil );
    return;
  }

  exportSession.outputURL = outputURL;
  exportSession.outputFileType = AVFileTypeAppleM4A;

  [exportSession exportAsynchronouslyWithCompletionHandler:^{
    if ( exportSession.status == AVAssetExportSessionStatusCompleted ) {
      resolve( outputPath );
      return;
    }

    NSString *message = exportSession.error.localizedDescription ?: @"Audio extraction failed";
    reject( @"EXTRACT_AUDIO_FAILED", message, exportSession.error );
  }];
}

@end
