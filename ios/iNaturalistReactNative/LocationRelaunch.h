#import <Foundation/Foundation.h>

// The location-history tracker's CLLocationManager, deliberately kept separate
// from the @react-native-community/geolocation manager. That library drives a
// single shared manager for the whole app, and its one-shot getCurrentPosition
// path stops the running watch and never restarts it, so a foreground geotag
// silently killed background tracking for the rest of the session.
//
// It runs two kinds of updates:
//
// - Continuous standard-location updates record the fine-grained track while
//   the app is alive, in the background as well as the foreground
//   (allowsBackgroundLocationUpdates), and with
//   pausesLocationUpdatesAutomatically off so iOS doesn't stop delivering the
//   moment it decides the user is stationary.
// - Significant-location-change monitoring keeps the app relaunchable after
//   iOS terminates it in the background. Standard updates never relaunch a
//   terminated app, so without this the tracked history shows a multi-hour gap
//   until the user manually reopens the app.
//
// Every fix is buffered here rather than pushed at JS, so fixes that arrive
// while JS is down (or suspended) survive. JS drains the buffer into Realm on
// startup and on a timer while tracking is on.
@interface INatLocationMonitor : NSObject
+ (instancetype)shared;
// Whether the user last had location history tracking enabled, persisted so
// AppDelegate can resume monitoring on a cold/background launch before JS boots.
+ (BOOL)enabled;
- (void)start;
- (void)stop;
// Returns and clears the buffered fixes.
- (NSArray<NSDictionary *> *)drainPendingLocations;
@end
