#import "PowerProfile.h"

#import <MetricKit/MetricKit.h>
#import <os/lock.h>
#import <os/signpost.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

// MetricKit keeps only a limited number of custom signposts per day, so the
// names are bounded: route names, "Background", and the few activities.
static const NSUInteger kMaxCategories = 80;

static os_unfair_lock ppLock = OS_UNFAIR_LOCK_INIT;
static NSMutableDictionary<NSString *, os_log_t> *ppLogs;      // category -> handle
static NSMutableDictionary<NSString *, NSNumber *> *ppOpen;    // category -> signpost id
static NSString *ppScreen;     // the screen JS last reported
static NSString *ppOpenScreen; // the screen interval now open, "Background" included
// Off until iOS says the app became active, so a background launch (a location
// relaunch) counts as background from the start.
static BOOL ppActive = NO;

// Must be called with ppLock held.
static os_log_t PPLog( NSString *category )
{
  if ( !ppLogs ) ppLogs = [NSMutableDictionary dictionary];
  os_log_t log = ppLogs[category];
  if ( !log && ppLogs.count < kMaxCategories ) {
    log = [MXMetricManager makeLogHandleWithCategory:category];
    ppLogs[category] = log;
  }
  return log;
}

// Must be called with ppLock held. The signpost name has to be a literal, so
// it's "Active" for all of them, and the category tells them apart.
static void PPSet( NSString *category, BOOL open )
{
  if ( !category.length ) return;
  if ( !ppOpen ) ppOpen = [NSMutableDictionary dictionary];
  NSNumber *existing = ppOpen[category];
  if ( open == ( existing != nil ) ) return;
  os_log_t log = PPLog( category );
  if ( !log ) return;
  if ( open ) {
    os_signpost_id_t spid = os_signpost_id_generate( log );
    MXSignpostIntervalBegin( log, spid, "Active" );
    ppOpen[category] = @( spid );
  } else {
    MXSignpostIntervalEnd( log, (os_signpost_id_t)existing.unsignedLongLongValue, "Active" );
    [ppOpen removeObjectForKey:category];
  }
}

// Must be called with ppLock held.
static void PPUpdateScreen( void )
{
  NSString *want = ppActive ? ppScreen : @"Background";
  if ( [want isEqualToString:ppOpenScreen] ) return;
  if ( ppOpenScreen ) PPSet( ppOpenScreen, NO );
  ppOpenScreen = want;
  if ( want ) PPSet( want, YES );
}

void INatPowerSetScreen( NSString *screen )
{
  os_unfair_lock_lock( &ppLock );
  ppScreen = [screen copy];
  PPUpdateScreen( );
  os_unfair_lock_unlock( &ppLock );
}

void INatPowerSetActivity( NSString *activity, BOOL active )
{
  os_unfair_lock_lock( &ppLock );
  PPSet( activity, active );
  os_unfair_lock_unlock( &ppLock );
}

static void PPAppStateChanged( BOOL active )
{
  os_unfair_lock_lock( &ppLock );
  ppActive = active;
  PPUpdateScreen( );
  os_unfair_lock_unlock( &ppLock );
}

@interface PowerProfile : NSObject <RCTBridgeModule>
@end

@implementation PowerProfile

RCT_EXPORT_MODULE( );

// Watches the app state from launch rather than from the module's creation,
// so time before JS asks for the module still counts as background.
+ (void)load
{
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidBecomeActiveNotification object:nil
                   queue:nil usingBlock:^( NSNotification *n ) { PPAppStateChanged( YES ); }];
  [nc addObserverForName:UIApplicationWillResignActiveNotification object:nil
                   queue:nil usingBlock:^( NSNotification *n ) { PPAppStateChanged( NO ); }];
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD( setScreen:( NSString * )screen )
{
  INatPowerSetScreen( screen );
}

@end
