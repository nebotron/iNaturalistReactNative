#import <React/RCTBridgeModule.h>

// iCloud key-value storage (NSUbiquitousKeyValueStore), which outlives the app
// being deleted and comes back when it is reinstalled under the same Apple ID.
// cloudBackup.ts mirrors the settings and progress kept in MMKV through it.
// Apple caps it at 1 MB and 1024 keys per app; every value here is a string.
// Below it, documents in iCloud Drive for what doesn't fit (cloudPhotoBackup).
@interface CloudKeyValueStore : NSObject <RCTBridgeModule>
@end

@implementation CloudKeyValueStore

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init
{
  if ( ( self = [super init] ) ) {
    // Asks iCloud for anything newer than the local copy
    [[NSUbiquitousKeyValueStore defaultStore] synchronize];
  }
  return self;
}

// Whether an iCloud account is signed in. Without one the store only keeps a
// local copy, which goes with the app.
RCT_EXPORT_METHOD( isAvailable:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  resolve( @( [[NSFileManager defaultManager] ubiquityIdentityToken] != nil ) );
}

RCT_EXPORT_METHOD( getAll:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  NSDictionary *all = [[NSUbiquitousKeyValueStore defaultStore] dictionaryRepresentation];
  NSMutableDictionary<NSString *, NSString *> *strings = [NSMutableDictionary dictionary];
  [all enumerateKeysAndObjectsUsingBlock:^( id key, id value, BOOL *stop ) {
    if ( [value isKindOfClass:[NSString class]] ) strings[key] = value;
  }];
  resolve( strings );
}

RCT_EXPORT_METHOD( update:(NSDictionary<NSString *, NSString *> *)values
                   removing:(NSArray<NSString *> *)removals
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  NSUbiquitousKeyValueStore *store = [NSUbiquitousKeyValueStore defaultStore];
  [values enumerateKeysAndObjectsUsingBlock:^( NSString *key, NSString *value, BOOL *stop ) {
    [store setString:value forKey:key];
  }];
  for ( NSString *key in removals ) [store removeObjectForKey:key];
  resolve( @( [store synchronize] ) );
}

// Documents too large for key-value storage, kept in the app's iCloud Drive
// container outside its Documents folder, so they don't show in Files.
// URLForUbiquityContainerIdentifier can block, so none of this runs on the
// main queue.
static NSURL *documentURL( NSString *name )
{
  NSURL *container = [[NSFileManager defaultManager] URLForUbiquityContainerIdentifier:nil];
  if ( !container ) return nil;
  NSURL *folder = [container URLByAppendingPathComponent:@"Backup" isDirectory:YES];
  [[NSFileManager defaultManager] createDirectoryAtURL:folder
                           withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];
  return [folder URLByAppendingPathComponent:name];
}

// status is "unavailable" (no iCloud), "downloading" (not here yet, which
// right after a reinstall includes iCloud not having said it exists), or "ok"
// with its contents
RCT_EXPORT_METHOD( readDocument:(NSString *)name
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_UTILITY, 0 ), ^{
    NSURL *url = documentURL( name );
    if ( !url ) {
      resolve( @{ @"status": @"unavailable" } );
      return;
    }
    id downloading = nil;
    [url getResourceValue:&downloading forKey:NSURLUbiquitousItemDownloadingStatusKey error:nil];
    BOOL current = [downloading isEqualToString:NSURLUbiquitousItemDownloadingStatusCurrent];
    if ( !current || ![[NSFileManager defaultManager] fileExistsAtPath:url.path] ) {
      [[NSFileManager defaultManager] startDownloadingUbiquitousItemAtURL:url error:nil];
      resolve( @{ @"status": @"downloading" } );
      return;
    }
    __block NSString *contents = nil;
    NSError *coordinationError = nil;
    [[[NSFileCoordinator alloc] initWithFilePresenter:nil]
      coordinateReadingItemAtURL:url
                         options:0
                           error:&coordinationError
                      byAccessor:^( NSURL *readURL ) {
      contents = [NSString stringWithContentsOfURL:readURL encoding:NSUTF8StringEncoding error:nil];
    }];
    if ( contents ) {
      resolve( @{ @"status": @"ok", @"contents": contents } );
    } else {
      reject( @"read_failed", @"Couldn't read the iCloud document", coordinationError );
    }
  } );
}

RCT_EXPORT_METHOD( writeDocument:(NSString *)name
                   contents:(NSString *)contents
                   resolver:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_UTILITY, 0 ), ^{
    NSURL *url = documentURL( name );
    if ( !url ) {
      resolve( @NO );
      return;
    }
    __block NSError *writeError = nil;
    NSError *coordinationError = nil;
    [[[NSFileCoordinator alloc] initWithFilePresenter:nil]
      coordinateWritingItemAtURL:url
                         options:NSFileCoordinatorWritingForReplacing
                           error:&coordinationError
                      byAccessor:^( NSURL *writeURL ) {
      [contents writeToURL:writeURL atomically:YES encoding:NSUTF8StringEncoding error:&writeError];
    }];
    NSError *error = coordinationError ?: writeError;
    if ( error ) {
      reject( @"write_failed", @"Couldn't write the iCloud document", error );
    } else {
      resolve( @YES );
    }
  } );
}

@end
