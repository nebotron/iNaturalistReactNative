#import "AppDelegate.h"

#import <Firebase.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <RNShareMenu/ShareMenuManager.h>
#import <React/RCTLinkingManager.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

@interface AppDelegate ()
@end

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

  return YES;
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
