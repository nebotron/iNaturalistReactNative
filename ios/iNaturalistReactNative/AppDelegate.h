#import <RCTDefaultReactNativeFactoryDelegate.h>
#import <RCTReactNativeFactory.h>
#import <UIKit/UIKit.h>

@interface AppDelegate : RCTDefaultReactNativeFactoryDelegate <UIApplicationDelegate>

// Created by SceneDelegate when the app's scene connects; nil before then,
// including for the whole of a background relaunch that never shows a scene.
@property (nonatomic, strong, nullable) UIWindow *window;
@property (nonatomic, strong, nonnull) RCTReactNativeFactory *reactNativeFactory;

// Puts the React Native root in `window`, starting React Native the first
// time. `sceneLaunchOptions` carries the URL or user activity the scene was
// opened with, which UIKit no longer puts in the app's launch options.
- (void)showReactNativeInWindow:(nonnull UIWindow *)window
             sceneLaunchOptions:(nonnull NSDictionary *)sceneLaunchOptions;

@end

// The app's one window scene. Apps built with the iOS 27 SDK must adopt the
// UIScene lifecycle: without a scene manifest, UIKit stops the app at launch
// on iOS 27 (EXC_BREAKPOINT in
// _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>

@property (nonatomic, strong, nullable) UIWindow *window;

@end