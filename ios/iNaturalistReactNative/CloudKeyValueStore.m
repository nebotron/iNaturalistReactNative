#import <React/RCTBridgeModule.h>

// iCloud key-value storage (NSUbiquitousKeyValueStore), which outlives the app
// being deleted and comes back when it is reinstalled under the same Apple ID.
// cloudBackup.ts mirrors the settings and progress kept in MMKV through it.
// Apple caps it at 1 MB and 1024 keys per app; every value here is a string.
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

@end
