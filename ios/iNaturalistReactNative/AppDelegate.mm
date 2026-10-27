#import "AppDelegate.h"
#import "LocationRelaunch.h"

#import <Firebase.h>
#import <React/RCTBridge.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <RNShareMenu/ShareMenuManager.h>
#import <React/RCTLinkingManager.h>
#import <QuartzCore/QuartzCore.h>
#import <MetricKit/MetricKit.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <mach-o/dyld.h>
#import <react/featureflags/ReactNativeFeatureFlags.h>
#import <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>
#if __has_include(<react_native_config/RNCConfig.h>)
#import <react_native_config/RNCConfig.h>
#else
#import "RNCConfig.h"
#endif

RCT_EXTERN NSArray<Class> *RCTGetModuleClasses( void );

// RN creates a main-queue-setup native module lazily on whichever thread first
// asks for it, by dispatch_sync'ing to the main queue. If the main thread asks
// for the same module meanwhile, it waits on the creating thread and both
// block for good: the watchdog kills behind every metrickit_crash. Creating
// all of those modules on the main queue before JS runs removes the race.
class INatFeatureFlags : public facebook::react::ReactNativeFeatureFlagsOverridesOSSStable {
 public:
  bool enableEagerMainQueueModulesOnIOS() override { return true; }
};

@interface AppDelegate () <MXMetricManagerSubscriber>
@end

// MetricKit's stack JSON names frames only by binary UUID and nests one level per
// frame, so the raw JSON cut to the log's size limit never reached the leaf
// frames. Flatten each thread to leaf-first lines, naming the binary and the
// nearest symbol dladdr finds for frames in images loaded in this process.
static NSDictionary<NSString *, NSValue *> *loadedImagesByUUID( void )
{
  NSMutableDictionary *images = [NSMutableDictionary new];
  for ( uint32_t i = 0; i < _dyld_image_count(); i++ ) {
    const struct mach_header_64 *header =
      (const struct mach_header_64 *) _dyld_get_image_header( i );
    const struct load_command *cmd = (const struct load_command *) ( header + 1 );
    for ( uint32_t c = 0; c < header->ncmds; c++ ) {
      if ( cmd->cmd == LC_UUID ) {
        NSUUID *uuid = [[NSUUID alloc]
          initWithUUIDBytes:( (const struct uuid_command *) cmd )->uuid];
        images[uuid.UUIDString] = [NSValue valueWithPointer:header];
        break;
      }
      cmd = (const struct load_command *) ( (const char *) cmd + cmd->cmdsize );
    }
  }
  return images;
}

static NSString *describeStack( MXCallStackTree *stack )
{
  NSDictionary *tree = [NSJSONSerialization JSONObjectWithData:[stack JSONRepresentation]
                                                       options:0 error:nil];
  if ( ![tree isKindOfClass:[NSDictionary class]] ) return nil;
  NSDictionary *images = loadedImagesByUUID();
  NSMutableString *out = [NSMutableString new];
  NSInteger threadIndex = 0;
  for ( NSDictionary *thread in tree[@"callStacks"] ) {
    NSMutableArray *frames = [NSMutableArray new];
    NSDictionary *frame = [thread[@"callStackRootFrames"] firstObject];
    while ( frame ) {
      [frames addObject:frame];
      // Follow the most-sampled branch, which for a crash is the only one
      NSDictionary *next = nil;
      for ( NSDictionary *sub in frame[@"subFrames"] ) {
        if ( !next || [sub[@"sampleCount"] integerValue] > [next[@"sampleCount"] integerValue] ) {
          next = sub;
        }
      }
      frame = next;
    }
    [out appendFormat:@"thread %ld%@:\n", (long) threadIndex++,
      [thread[@"threadAttributed"] boolValue] ? @" (attributed)" : @""];
    NSInteger shown = 0;
    for ( NSDictionary *f in frames.reverseObjectEnumerator ) {
      if ( shown++ >= 40 ) break;
      NSString *uuid = f[@"binaryUUID"];
      uint64_t offset = [f[@"offsetIntoBinaryTextSegment"] unsignedLongLongValue];
      const char *address = (const char *) [images[uuid] pointerValue];
      NSString *where = [NSString stringWithFormat:@"%@+0x%llx",
        f[@"binaryName"] ?: [uuid substringToIndex:MIN( uuid.length, 8 )], offset];
      Dl_info info;
      if ( address && dladdr( address + offset, &info ) ) {
        NSString *image = [@( info.dli_fname ?: "" ) lastPathComponent];
        where = info.dli_sname
          ? [NSString stringWithFormat:@"%@ %s+%ld (+0x%llx)", image, info.dli_sname,
              (long) ( address + offset - (const char *) info.dli_saddr ), offset]
          : [NSString stringWithFormat:@"%@+0x%llx", image, offset];
      }
      [out appendFormat:@"  %@\n", where];
    }
  }
  return out;
}

// iOS's own reports of the crashes and hangs the JS handlers can't see: signals
// (EXC_BAD_ACCESS and the like), watchdog kills, and main-thread hangs. MetricKit
// hands over the previous launches' reports at the next launch, and they go
// straight to the app log from here, so a launch that dies before JS logs
// anything is still on the record.
static void postDiagnostic( NSString *message, NSDictionary *fields, MXCallStackTree *stack )
{
  NSString *base = [RNCConfig envFor:@"CROP_LOG_FIREBASE_URL"];
  if ( base.length == 0 ) return;
  NSMutableDictionary *entry = [fields mutableCopy];
  NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
  iso.formatOptions |= NSISO8601DateFormatWithFractionalSeconds;
  entry[@"timestamp"] = [iso stringFromDate:[NSDate date]];
  entry[@"level"] = @"error";
  entry[@"extension"] = @"MetricKit";
  entry[@"commit"] = [NSString stringWithFormat:@"build-%@",
    [NSBundle mainBundle].infoDictionary[@"CFBundleVersion"]];
  entry[@"message"] = message;
  NSString *stackText = describeStack( stack );
  if ( stackText.length > 30000 ) stackText = [stackText substringToIndex:30000];
  if ( stackText ) entry[@"stack"] = stackText;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:
    [NSURL URLWithString:[base stringByAppendingString:@"/app_log.json"]]];
  request.HTTPMethod = @"POST";
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
  [[[NSURLSession sharedSession] dataTaskWithRequest:request] resume];
}

static NSString *describe( id value )
{
  return value ? [NSString stringWithFormat:@"%@", value] : @"";
}

// React Native's Image component (both legacy and Fabric) renders by setting
// CALayer.contents directly to a CGImage rather than going through
// UIImageView, so swizzling this is the one hook point that covers every
// image view in the app for a pixelated, nearest-neighbor look.
@interface CALayer (PixelatedImages)
@end

@implementation CALayer (PixelatedImages)

+ (void)load
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    Method originalMethod = class_getInstanceMethod(self, @selector(setContents:));
    Method swizzledMethod = class_getInstanceMethod(self, @selector(pixelated_setContents:));
    method_exchangeImplementations(originalMethod, swizzledMethod);
  });
}

- (void)pixelated_setContents:(id)contents
{
  // Calls through to the original -setContents: implementation (swapped via the exchange above).
  [self pixelated_setContents:contents];
  if (contents) {
    self.magnificationFilter = kCAFilterNearest;
    self.minificationFilter = kCAFilterNearest;
  }
}

@end

@implementation AppDelegate

// https://reactnative.dev/docs/linking#get-the-deep-link
- (BOOL)application:(UIApplication *)app
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  BOOL handledByShareMenu = [ShareMenuManager application:app openURL:url options:options];
  BOOL handledByLinkingManager = [RCTLinkingManager application:app openURL:url options:options];

  // Return YES if either of the managers can handle the URL
  return handledByShareMenu || handledByLinkingManager;
}

- (BOOL)application:(UIApplication *)application continueUserActivity:(nonnull NSUserActivity *)userActivity
 restorationHandler:(nonnull void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler
{
  return [RCTLinkingManager application:application
                   continueUserActivity:userActivity
                     restorationHandler:restorationHandler];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  // Required for react-native-firebase: https://rnfirebase.io/#configure-firebase-with-ios-credentials-react-native--077
  @try {
    [FIRApp configure];
  } @catch (NSException *exception) {
    NSLog(@"Skipping Firebase configuration due to invalid local GoogleService-Info.plist: %@", exception.reason);
  }
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self];
  facebook::react::ReactNativeFeatureFlags::dangerouslyForceOverride(
    std::make_unique<INatFeatureFlags>() );
  self.dependencyProvider = [RCTAppDependencyProvider new];

  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];

  [self.reactNativeFactory startReactNativeWithModuleName:@"iNaturalistReactNative"
                                                 inWindow:self.window
                                        initialProperties:@{}
                                            launchOptions:launchOptions];

  // Resume location monitoring when the user had location history tracking
  // enabled, or when iOS relaunched us because of a location event. Starting
  // here rather than waiting for JS means a background relaunch resumes the
  // continuous watch immediately, and significant-change monitoring keeps the
  // app relaunchable after iOS terminates it - which is what prevents
  // multi-hour gaps in the tracked history, since a standard-location watch
  // alone cannot relaunch a killed app.
  if ( launchOptions[UIApplicationLaunchOptionsLocationKey] || [INatLocationMonitor enabled] ) {
    [[INatLocationMonitor shared] start];
  }

  [[MXMetricManager sharedManager] addSubscriber:self];

  return YES;
}

- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads
{
  for ( MXDiagnosticPayload *payload in payloads ) {
    for ( MXCrashDiagnostic *crash in payload.crashDiagnostics ) {
      postDiagnostic( @"metrickit_crash", @{
        @"appBuild": describe( crash.metaData.applicationBuildVersion ),
        @"exceptionType": describe( crash.exceptionType ),
        @"exceptionCode": describe( crash.exceptionCode ),
        @"signal": describe( crash.signal ),
        @"terminationReason": describe( crash.terminationReason ),
        @"vmRegion": describe( crash.virtualMemoryRegionInfo ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, crash.callStackTree );
    }
    for ( MXHangDiagnostic *hang in payload.hangDiagnostics ) {
      postDiagnostic( @"metrickit_hang", @{
        @"appBuild": describe( hang.metaData.applicationBuildVersion ),
        @"hangDuration": describe( hang.hangDuration ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, hang.callStackTree );
    }
  }
}

// Mirrors RCTTurboModuleManager's _requiresMainQueueSetup:, so every module RN
// would set up on the main queue is created there eagerly (see INatFeatureFlags).
- (NSArray<NSString *> *)unstableModulesRequiringMainQueueSetup
{
  NSMutableArray<NSString *> *names = [[super unstableModulesRequiringMainQueueSetup] mutableCopy];
  IMP objectInit = [NSObject instanceMethodForSelector:@selector( init )];
  for ( Class moduleClass in RCTGetModuleClasses() ) {
    BOOL requiresMainQueue = [moduleClass respondsToSelector:@selector( requiresMainQueueSetup )]
      ? [moduleClass requiresMainQueueSetup]
      : [moduleClass instancesRespondToSelector:@selector( constantsToExport )]
        || [moduleClass instanceMethodForSelector:@selector( init )] != objectInit;
    if ( requiresMainQueue ) [names addObject:RCTBridgeModuleNameForClass( moduleClass )];
  }
  return names;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}
 
- (NSURL *)bundleURL
{
#if DEBUG
  return [RCTBundleURLProvider.sharedSettings jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
