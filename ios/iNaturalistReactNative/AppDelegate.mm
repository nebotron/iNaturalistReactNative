#import "AppDelegate.h"
#import "LocationRelaunch.h"

#import <Firebase.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <RNShareMenu/ShareMenuManager.h>
#import <React/RCTLinkingManager.h>
#import <QuartzCore/QuartzCore.h>
#import <MetricKit/MetricKit.h>
#import <objc/runtime.h>
#if __has_include(<react_native_config/RNCConfig.h>)
#import <react_native_config/RNCConfig.h>
#else
#import "RNCConfig.h"
#endif

@interface AppDelegate () <MXMetricManagerSubscriber>
@end

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
  NSString *stackJson = [[NSString alloc] initWithData:[stack JSONRepresentation]
                                              encoding:NSUTF8StringEncoding];
  if ( stackJson.length > 30000 ) stackJson = [stackJson substringToIndex:30000];
  if ( stackJson ) entry[@"stack"] = stackJson;
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
