#import <Foundation/Foundation.h>

// A dedicated significant-location-change monitor, deliberately kept separate
// from the @react-native-community/geolocation CLLocationManager so it can run
// alongside the continuous background watch (that library drives a single
// shared manager and only honours the first watch's options).
//
// Its job is to keep the app relaunchable after iOS terminates it in the
// background. Standard location updates never relaunch a terminated app, so
// once iOS kills a backgrounded app the continuous watch stops and the tracked
// history shows a multi-hour gap until the user manually reopens the app.
// Significant-change monitoring *does* relaunch a terminated app (via
// UIApplicationLaunchOptionsLocationKey), which lets us resume the continuous
// watch and fill the gap. Fixes delivered while JS is down are buffered here
// and drained into Realm on the next JS startup.
@interface INatLocationMonitor : NSObject
+ (instancetype)shared;
// Whether the user last had location history tracking enabled, persisted so
// AppDelegate can resume monitoring on a cold/background launch before JS boots.
+ (BOOL)enabled;
- (void)start;
- (void)stop;
// Returns and clears the buffered significant-change fixes.
- (NSArray<NSDictionary *> *)drainPendingLocations;
@end
