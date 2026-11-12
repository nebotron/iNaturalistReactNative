#import "LocationRelaunch.h"

#import <CoreLocation/CoreLocation.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>

static NSString *const kEnabledKey = @"INatLocationMonitorEnabled";
// Where fixes used to be buffered, as one NSUserDefaults array that every fix
// read, copied and wrote back whole (up to kMaxPending entries). Only drained
// now, for fixes an older build left there.
static NSString *const kLegacyPendingKey = @"INatLocationMonitorPending";
// Most fixes handed to JS in one drain, the newest ones. JS drains every 5
// minutes while the app is in use, and whenever it geotags, so the buffer only
// grows while the app is in the background, suspended or terminated, and at
// 32 bytes a fix even weeks of that stay small on disk.
static const NSUInteger kMaxPending = 2000;

// One buffered fix. Each is appended to the buffer file as it arrives, so a fix
// costs a 32-byte write, and nothing already buffered is read or rewritten.
typedef struct {
  double latitude;
  double longitude;
  double accuracy;
  double timestamp; // ms since 1970
} INatPendingFix;

static NSString *pendingFilePath( void )
{
  static NSString *path = nil;
  static dispatch_once_t onceToken;
  dispatch_once( &onceToken, ^{
    NSURL *dir = [[NSFileManager defaultManager]
      URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    [[NSFileManager defaultManager] createDirectoryAtURL:dir
                             withIntermediateDirectories:YES attributes:nil error:nil];
    path = [dir.path stringByAppendingPathComponent:@"INatLocationMonitorPending.bin"];
  } );
  return path;
}

// Appends whole INatPendingFix records to the buffer file.
static void appendPendingFixes( NSData *fixes )
{
  if ( fixes.length == 0 ) return;
  int fd = open( pendingFilePath( ).fileSystemRepresentation,
                 O_WRONLY | O_APPEND | O_CREAT, 0644 );
  if ( fd < 0 ) return;
  // A write cut short (the app killed mid-write) leaves a partial record; drop
  // it so the records after it stay aligned.
  struct stat info;
  if ( fstat( fd, &info ) == 0 && info.st_size % (off_t)sizeof( INatPendingFix ) ) {
    ftruncate( fd, info.st_size - info.st_size % (off_t)sizeof( INatPendingFix ) );
  }
  write( fd, fixes.bytes, fixes.length );
  close( fd );
}
// Only record a fix once the user has moved this far, which keeps continuous
// background tracking power-efficient. Mirrors MIN_DISTANCE_METERS in
// locationHistoryTracker.ts.
static const CLLocationDistance kDistanceFilterMeters = 50;

@interface INatLocationMonitor () <CLLocationManagerDelegate>
@property (nonatomic, strong) CLLocationManager *manager;
@property (nonatomic) BOOL paused;
@property (nonatomic) BOOL precise;
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
      // Let iOS turn the GPS off while the user is stationary; the
      // significant-change monitor below relaunches/resumes updates once they
      // move again (see locationManagerDidPauseLocationUpdates:).
      self.manager.pausesLocationUpdatesAutomatically = YES;
      // CLActivityTypeFitness tells iOS this is a moving-on-foot session so it
      // can manage the location radio accordingly.
      self.manager.activityType = CLActivityTypeFitness;
      self.manager.distanceFilter = kDistanceFilterMeters;
      NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
      [nc addObserver:self selector:@selector( updateAccuracy )
                 name:UIApplicationDidBecomeActiveNotification object:nil];
      [nc addObserver:self selector:@selector( updateAccuracy )
                 name:UIApplicationDidEnterBackgroundNotification object:nil];
    }
    [self updateAccuracy];
    [self.manager startMonitoringSignificantLocationChanges];
    [self.manager startUpdatingLocation];
  } );
}

// ~100 m, which is enough to geotag photos and lets iOS locate us from Wi-Fi
// and cell towers with the GPS mostly off. ~10 m only while the app is in use
// and already running the GPS for a precise watch of its own (the camera),
// when the finer track costs nothing extra. It used to be ~10 m whenever the
// app was in use, which kept the GPS on for all of it.
- (void)updateAccuracy
{
  BOOL active = [UIApplication sharedApplication].applicationState == UIApplicationStateActive;
  self.manager.desiredAccuracy = active && self.precise
    ? kCLLocationAccuracyNearestTenMeters
    : kCLLocationAccuracyHundredMeters;
  // Opening the app is a good moment to pick a paused session back up
  if ( active && self.paused && [INatLocationMonitor enabled] ) {
    self.paused = NO;
    [self.manager startUpdatingLocation];
  }
}

- (void)setPrecise:(BOOL)precise
{
  dispatch_async( dispatch_get_main_queue(), ^{
    self.precise = precise;
    if ( self.manager ) [self updateAccuracy];
  } );
}

// Once iOS pauses for a stationary user, it won't resume on its own; the
// significant-change monitor wakes us when they move, and we resume then.
- (void)locationManagerDidPauseLocationUpdates:(CLLocationManager *)manager
{
  self.paused = YES;
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
  if ( self.paused ) {
    // A significant-change fix after a pause: the user moved, so resume
    self.paused = NO;
    [manager startUpdatingLocation];
  }
  NSMutableData *fixes = [NSMutableData data];
  for ( CLLocation *location in locations ) {
    INatPendingFix fix = {
      .latitude = location.coordinate.latitude,
      .longitude = location.coordinate.longitude,
      .accuracy = location.horizontalAccuracy,
      .timestamp = location.timestamp.timeIntervalSince1970 * 1000.0,
    };
    [fixes appendBytes:&fix length:sizeof( fix )];
  }
  appendPendingFixes( fixes );
}

- (NSArray<NSDictionary *> *)drainPendingLocations
{
  NSMutableArray<NSDictionary *> *pending = [NSMutableArray array];
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSArray *legacy = [defaults arrayForKey:kLegacyPendingKey];
  if ( legacy ) {
    [pending addObjectsFromArray:legacy];
    [defaults removeObjectForKey:kLegacyPendingKey];
  }
  NSString *path = pendingFilePath( );
  NSData *data = [NSData dataWithContentsOfFile:path];
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  // A trailing partial record (a write cut short) is dropped.
  NSUInteger records = data.length / sizeof( INatPendingFix );
  const INatPendingFix *fixes = (const INatPendingFix *)data.bytes;
  NSUInteger first = records > kMaxPending ? records - kMaxPending : 0;
  for ( NSUInteger i = first; i < records; i++ ) {
    [pending addObject:@{
      @"latitude": @( fixes[i].latitude ),
      @"longitude": @( fixes[i].longitude ),
      @"accuracy": @( fixes[i].accuracy ),
      @"timestamp": @( fixes[i].timestamp ),
    }];
  }
  return pending;
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

RCT_EXPORT_METHOD( setPrecise:( BOOL )precise )
{
  [[INatLocationMonitor shared] setPrecise:precise];
}

RCT_EXPORT_METHOD( drainPendingLocations:(RCTPromiseResolveBlock)resolve
                   rejecter:(RCTPromiseRejectBlock)reject )
{
  resolve( [[INatLocationMonitor shared] drainPendingLocations] );
}

@end
