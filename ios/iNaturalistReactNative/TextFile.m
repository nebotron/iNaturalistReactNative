#import <React/RCTBridgeModule.h>

// Reads and writes whole text files as UTF-8, for the HTTP cache
// (httpCache.ts). react-native-fs takes and returns file contents as base64,
// so a string written through it is converted to UTF-8 bytes and then to
// base64 in JavaScript, and back again on every read. For API responses of a
// megabyte or more that conversion was most of the JS thread's work on
// Explore (46% of JS samples in one profile, build 1124). Here the string
// crosses the bridge as a string and Foundation does the encoding.
@interface TextFile : NSObject <RCTBridgeModule>
@end

@implementation TextFile

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

// Its own serial queue, so cache I/O never waits behind another module's work
- (dispatch_queue_t)methodQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    queue = dispatch_queue_create( "org.inaturalist.textfile",
      dispatch_queue_attr_make_with_qos_class( DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0 ) );
  } );
  return queue;
}

// Writes contents to path, replacing any file there, and creates the
// directory holding it if it doesn't exist yet
RCT_EXPORT_METHOD( writeUtf8:(NSString *)path
                   contents:(NSString *)contents
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  NSError *error = nil;
  NSString *directory = [path stringByDeletingLastPathComponent];
  if ( ![[NSFileManager defaultManager] createDirectoryAtPath:directory
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:&error] ) {
    reject( @"ENOENT", error.localizedDescription, error );
    return;
  }
  if ( ![contents writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:&error] ) {
    reject( @"EWRITE", error.localizedDescription, error );
    return;
  }
  resolve( nil );
}

RCT_EXPORT_METHOD( readUtf8:(NSString *)path
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  NSError *error = nil;
  NSString *contents = [NSString stringWithContentsOfFile:path
                                                 encoding:NSUTF8StringEncoding
                                                    error:&error];
  if ( !contents ) {
    reject( @"ENOENT", error.localizedDescription, error );
    return;
  }
  resolve( contents );
}

@end
