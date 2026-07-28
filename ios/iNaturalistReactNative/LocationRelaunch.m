#import "LocationRelaunch.h"

#import <CoreLocation/CoreLocation.h>
#import <React/RCTBridgeModule.h>

static NSString *const kEnabledKey = @"INatLocationMonitorEnabled";
static NSString *const kPendingKey = @"INatLocationMonitorPending";
// Cap the buffered fixes so a long stretch with JS down can't grow
// NSUserDefaults without bound. JS drains every minute while it's running, so
// this only fills up while the app is terminated or suspended.
static const NSUInteger kMaxPending = 2000;
// Only record a fix once the user has moved this far, which keeps continuous
// background tracking power-efficient. Mirrors MIN_DISTANCE_METERS in
// locationHistoryTracker.ts.
static const CLLocationDistance kDistanceFilterMeters = 50;

@interface INatLocationMonitor () <CLLocationManagerDelegate>
@property (nonatomic, strong) CLLocationManager *manager;
@end

@implementation INatLocationMonitor

+ (instancetype)shared
{
  static INatLocationMonitor *shared = nil;
  static dispatch_once_t onceToken;
  dispatch_once( &onceToken, ^{
    shared = [INatLocationMonitor new];
  } );
  return shared;
}

+ (BOOL)enabled
{
  return [[NSUserDefaults standardUserDefaults] boolForKey:kEnabledKey];
}

- (void)start
{
  [[NSUserDefaults standardUserDefaults] setBool:YES forKey:kEnabledKey];
  // CLLocationManager must be created and driven on a thread with a run loop.
  // Staying on the main queue also means delegate callbacks and
  // drainPendingLocations can't interleave, so a fix can't be dropped between
  // reading the buffer and clearing it.
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( !self.manager ) {
      self.manager = [CLLocationManager new];
      self.manager.delegate = self;
      self.manager.allowsBackgroundLocationUpdates = YES;
      // Otherwise iOS pauses updates whenever it decides the user is
      // stationary and does not resume them on its own for a long time, which
      // leaves long gaps in the tracked history.
      self.manager.pausesLocationUpdatesAutomatically = NO;
      // ~10 m is plenty to geotag photos and draws far less power than
      // kCLLocationAccuracyBest, and CLActivityTypeFitness tells iOS this is a
      // moving-on-foot session so it can manage the location radio accordingly.
      self.manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters;
      self.manager.activityType = CLActivityTypeFitness;
      self.manager.distanceFilter = kDistanceFilterMeters;
    }
    [self.manager startMonitoringSignificantLocationChanges];
    [self.manager startUpdatingLocation];
  } );
}

- (void)stop
{
  [[NSUserDefaults standardUserDefaults] setBool:NO forKey:kEnabledKey];
  dispatch_async( dispatch_get_main_queue(), ^{
    [self.manager stopUpdatingLocation];
    [self.manager stopMonitoringSignificantLocationChanges];
  } );
}

- (void)locationManager:(CLLocationManager *)manager
     didUpdateLocations:(NSArray<CLLocation *> *)locations
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSMutableArray *pending = [[defaults arrayForKey:kPendingKey] mutableCopy];
  if ( !pending ) pending = [NSMutableArray array];
  for ( CLLocation *location in locations ) {
    [pending addObject:@{
      @"latitude": @( location.coordinate.latitude ),
      @"longitude": @( location.coordinate.longitude ),
      @"accuracy": @( location.horizontalAccuracy ),
      @"timestamp": @( location.timestamp.timeIntervalSince1970 * 1000.0 ),
    }];
  }
  if ( pending.count > kMaxPending ) {
    [pending removeObjectsInRange:NSMakeRange( 0, pending.count - kMaxPending )];
  }
  [defaults setObject:pending forKey:kPendingKey];
}

- (NSArray<NSDictionary *> *)drainPendingLocations
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSArray *pending = [defaults arrayForKey:kPendingKey];
  [defaults removeObjectForKey:kPendingKey];
  return pending ?: @[];
}

@end

@interface LocationRelaunch : NSObject <RCTBridgeModule>
@end

@implementation LocationRelaunch

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// Run on the main queue so drains are serialized against the location
// manager's delegate callbacks (see -start).
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD( start )
{
  [[INatLocationMonitor shared] start];
}

RCT_EXPORT_METHOD( stop )
{
  [[INatLocationMonitor shared] stop];
}

RCT_EXPORT_METHOD( drainPendingLocations:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  resolve( [[INatLocationMonitor shared] drainPendingLocations] );
}

@end
