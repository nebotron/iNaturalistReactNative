#import "LocationRelaunch.h"

#import <CoreLocation/CoreLocation.h>
#import <React/RCTBridgeModule.h>

static NSString *const kEnabledKey = @"INatLocationMonitorEnabled";
static NSString *const kPendingKey = @"INatLocationMonitorPending";
// Cap the buffered fixes so a long stretch offline can't grow NSUserDefaults
// without bound. Significant-change fixes are sparse, so this is generous.
static const NSUInteger kMaxPending = 500;

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
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( !self.manager ) {
      self.manager = [CLLocationManager new];
      self.manager.delegate = self;
      self.manager.allowsBackgroundLocationUpdates = YES;
      self.manager.pausesLocationUpdatesAutomatically = NO;
    }
    [self.manager startMonitoringSignificantLocationChanges];
  } );
}

- (void)stop
{
  [[NSUserDefaults standardUserDefaults] setBool:NO forKey:kEnabledKey];
  dispatch_async( dispatch_get_main_queue(), ^{
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
