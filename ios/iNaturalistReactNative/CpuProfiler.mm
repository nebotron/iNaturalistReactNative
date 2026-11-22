#import "CpuProfiler.h"
#import "PowerProfile.h"

#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <mach/mach.h>
#import <pthread.h>
#import <sys/resource.h>

#if __has_include(<hermes/hermes.h>)
#include <hermes/hermes.h>
#include <sstream>
#define INAT_HAS_HERMES_PROFILER 1
#endif

static const double kTickSec = 5;
static const int kWindowTicks = 6;          // 30 s
static const double kTriggerCores = 0.6;    // average share of one core over the window
static const double kBurstSec = 8;
static const double kBurstHz = 50;
static const double kCooldownSec = 10 * 60;
static const int kMaxBursts = 4;
// Always on while the app is in front, at a rate whose cost is a few thread
// wakeups a second. Off in the background, where those wakeups would be most
// of what the app does; a burst still covers high CPU there.
static const double kContinuousHz = 5;
static const int kCollectTicks = 12;        // fold samples in every minute
static const int kSummaryTicks = 180;       // report every 15 minutes in front
// A summary with less JS than this (30 s busy at 5 Hz) says little
static const NSInteger kMinSummaryJsSamples = 150;

static dispatch_queue_t cpQueue;
static dispatch_source_t cpTimer;
static INatCpuReport cpReport;
static pthread_t cpMainThread;
static double cpLastCpu;
static double cpWindow[kWindowTicks];
static int cpTicks;
static BOOL cpBursting;
static int cpBursts;
static double cpLastBurstAt = -1;
static BOOL cpActive;
static double cpSamplingHz;

static double processCpuSeconds( void )
{
  struct rusage usage;
  if ( getrusage( RUSAGE_SELF, &usage ) != 0 ) return 0;
  return usage.ru_utime.tv_sec + usage.ru_utime.tv_usec / 1e6
    + usage.ru_stime.tv_sec + usage.ru_stime.tv_usec / 1e6;
}

// thread id -> @[name, cpu seconds]
static NSDictionary<NSNumber *, NSArray *> *threadTimes( void )
{
  NSMutableDictionary *out = [NSMutableDictionary new];
  thread_act_array_t threads;
  mach_msg_type_number_t count = 0;
  if ( task_threads( mach_task_self(), &threads, &count ) != KERN_SUCCESS ) return out;
  for ( mach_msg_type_number_t i = 0; i < count; i++ ) {
    thread_identifier_info_data_t ident;
    mach_msg_type_number_t identCount = THREAD_IDENTIFIER_INFO_COUNT;
    thread_basic_info_data_t basic;
    mach_msg_type_number_t basicCount = THREAD_BASIC_INFO_COUNT;
    if ( thread_info( threads[i], THREAD_IDENTIFIER_INFO, (thread_info_t) &ident,
                      &identCount ) == KERN_SUCCESS
         && thread_info( threads[i], THREAD_BASIC_INFO, (thread_info_t) &basic,
                         &basicCount ) == KERN_SUCCESS ) {
      double seconds = basic.user_time.seconds + basic.user_time.microseconds / 1e6
        + basic.system_time.seconds + basic.system_time.microseconds / 1e6;
      char name[96] = { 0 };
      pthread_t pthread = pthread_from_mach_thread_np( threads[i] );
      if ( pthread ) pthread_getname_np( pthread, name, sizeof( name ) );
      NSString *label = name[0]
        ? @( name )
        : ( pthread && pthread_equal( pthread, cpMainThread ) ? @"main" : @"(unnamed)" );
      out[@( ident.thread_id )] = @[label, @( seconds )];
    }
    mach_port_deallocate( mach_task_self(), threads[i] );
  }
  vm_deallocate( mach_task_self(), (vm_address_t) threads, count * sizeof( thread_t ) );
  return out;
}

// Each thread's share of a core between two snapshots, busiest first, with
// the unnamed worker threads (GCD's) added up into one line.
static NSString *describeThreads( NSDictionary<NSNumber *, NSArray *> *before,
                                  NSDictionary<NSNumber *, NSArray *> *after, double elapsed )
{
  NSMutableDictionary<NSString *, NSNumber *> *byName = [NSMutableDictionary new];
  NSMutableDictionary<NSString *, NSNumber *> *threadsByName = [NSMutableDictionary new];
  [after enumerateKeysAndObjectsUsingBlock:^( NSNumber *tid, NSArray *now, BOOL *stop ) {
    double delta = [now[1] doubleValue] - [before[tid][1] doubleValue];
    if ( delta <= 0 ) return;
    NSString *name = now[0];
    byName[name] = @( byName[name].doubleValue + delta );
    threadsByName[name] = @( threadsByName[name].integerValue + 1 );
  }];
  NSArray *names = [byName keysSortedByValueUsingComparator:^( NSNumber *a, NSNumber *b ) {
    return [b compare:a];
  }];
  NSMutableString *out = [NSMutableString new];
  for ( NSUInteger i = 0; i < MIN( (NSUInteger) 12, names.count ); i++ ) {
    NSInteger n = threadsByName[names[i]].integerValue;
    [out appendFormat:@"%5.1f%%  %@%@\n", 100 * byName[names[i]].doubleValue / elapsed, names[i],
      n > 1 ? [NSString stringWithFormat:@" (%ld threads)", (long) n] : @""];
  }
  return out;
}

static void addCount( NSMutableDictionary<NSString *, NSNumber *> *counts, NSString *key,
                      NSInteger n )
{
  counts[key] = @( counts[key].integerValue + n );
}

static NSArray *sortedKeys( NSDictionary<NSString *, NSNumber *> *counts )
{
  return [counts keysSortedByValueUsingComparator:^( NSNumber *a, NSNumber *b ) {
    return [b compare:a];
  }];
}

// JS samples added up over any number of dumps
@interface INatJsSamples : NSObject
@property ( nonatomic ) NSMutableDictionary<NSString *, NSNumber *> *selfCounts;
@property ( nonatomic ) NSMutableDictionary<NSString *, NSNumber *> *totalCounts;
// keyed by the stack as reported, leaf first
@property ( nonatomic ) NSMutableDictionary<NSString *, NSNumber *> *stackCounts;
@property ( nonatomic ) NSInteger total;
@property ( nonatomic ) NSInteger inJs;
@end

@implementation INatJsSamples
- ( instancetype )init
{
  if ( ( self = [super init] ) ) {
    _selfCounts = [NSMutableDictionary new];
    _totalCounts = [NSMutableDictionary new];
    _stackCounts = [NSMutableDictionary new];
  }
  return self;
}
@end

static INatJsSamples *cpPeriod;
static NSDictionary *cpPeriodThreads;
static double cpPeriodCpu;
static double cpPeriodStartedAt;
static int cpPeriodTicks;
static NSMutableDictionary<NSString *, NSNumber *> *cpPeriodScreens;

static void appendCounts( NSMutableString *out, NSString *title, NSDictionary *counts,
                          NSInteger total, NSUInteger limit )
{
  NSArray *keys = sortedKeys( counts );
  [out appendFormat:@"%@:\n", title];
  for ( NSUInteger i = 0; i < MIN( limit, keys.count ); i++ ) {
    NSInteger n = [counts[keys[i]] integerValue];
    [out appendFormat:@"  %5ld %4.1f%%  %@\n", (long) n, total ? 100.0 * n / total : 0.0, keys[i]];
  }
}

static NSDictionary *describeSamples( INatJsSamples *samples )
{
  NSMutableString *out = [NSMutableString new];
  appendCounts( out, @"JS top self", samples.selfCounts, samples.inJs, 30 );
  appendCounts( out, @"JS top inclusive", samples.totalCounts, samples.inJs, 30 );
  NSArray *stacks = sortedKeys( samples.stackCounts );
  [out appendString:@"JS heaviest stacks (leaf first):\n"];
  for ( NSUInteger i = 0; i < MIN( (NSUInteger) 10, stacks.count ); i++ ) {
    NSInteger n = samples.stackCounts[stacks[i]].integerValue;
    [out appendFormat:@"  [%ld samples, %.1f%%]\n%@", (long) n,
      samples.inJs ? 100.0 * n / samples.inJs : 0.0, stacks[i]];
  }
  if ( out.length > 40000 ) [out setString:[out substringToIndex:40000]];
  return @{
    @"samples": @( samples.total ),
    // Samples that found the JS thread running JavaScript; the rest were
    // outside it (native work, or idle)
    @"jsSamples": @( samples.inJs ),
    @"profile": out,
  };
}

#ifdef INAT_HAS_HERMES_PROFILER
static facebook::hermes::IHermesRootAPI *hermesRoot( void )
{
  return facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(
    facebook::hermes::makeHermesRootAPI() );
}

// "fn(/long/path/main.jsbundle:12:34)" -> "fn(main.jsbundle:12:34)"
static NSString *shortFrameName( NSString *name )
{
  NSRange open = [name rangeOfString:@"(" options:NSBackwardsSearch];
  if ( open.location == NSNotFound ) return name;
  NSRange slash = [name rangeOfString:@"/" options:NSBackwardsSearch];
  if ( slash.location == NSNotFound || slash.location < open.location ) return name;
  return [[name substringToIndex:open.location + 1]
    stringByAppendingString:[name substringFromIndex:slash.location + 1]];
}

// The function a frame is in, without the position it was sampled at, so a
// function's samples add up across its lines: "fn (line:col of fn's start)"
static NSString *functionName( NSDictionary *frame )
{
  NSString *name = [frame[@"name"] description] ?: @"?";
  if ( ![frame[@"category"] isEqual:@"JavaScript"] ) return name;
  NSRange open = [name rangeOfString:@"(" options:NSBackwardsSearch];
  NSString *base = open.location == NSNotFound ? name : [name substringToIndex:open.location];
  if ( base.length == 0 ) base = @"(anonymous)";
  if ( frame[@"funcLine"] ) {
    return [NSString stringWithFormat:@"%@ (%@:%@)", base, frame[@"funcLine"], frame[@"funcColumn"]];
  }
  if ( frame[@"funcVirtAddr"] ) return [NSString stringWithFormat:@"%@ @%@", base, frame[@"funcVirtAddr"]];
  return base;
}

// The stack as it's reported: leaf first, positioned names, the middle of a
// deep one elided
static NSString *stackText( NSArray *path )
{
  NSArray *leafFirst = path.reverseObjectEnumerator.allObjects;
  const NSUInteger leafKept = 20, rootKept = 8;
  NSMutableString *out = [NSMutableString new];
  for ( NSUInteger j = 0; j < leafFirst.count; j++ ) {
    if ( leafFirst.count > leafKept + rootKept && j == leafKept ) {
      [out appendFormat:@"    ... %lu frames ...\n",
        (unsigned long) ( leafFirst.count - leafKept - rootKept )];
      j = leafFirst.count - rootKept;
    }
    [out appendFormat:@"    %@\n", leafFirst[j][1]];
  }
  return out;
}

// Adds Hermes's Chrome trace to `samples`: samples point at a stack frame
// id, and each frame at its parent, up to "[root]".
static void addTrace( const std::string &json, INatJsSamples *samples )
{
  NSData *data = [NSData dataWithBytesNoCopy:(void *) json.data() length:json.size()
                                freeWhenDone:NO];
  NSDictionary *trace = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if ( ![trace isKindOfClass:[NSDictionary class]] ) return;
  NSDictionary *frames = trace[@"stackFrames"];
  NSMutableDictionary<NSString *, NSArray *> *pathCache = [NSMutableDictionary new];
  NSMutableDictionary<NSString *, NSString *> *textCache = [NSMutableDictionary new];
  // Root first, [root] left out; frames as @[function, positioned name]
  NSArray *( ^pathOf )( NSString * ) = ^NSArray *( NSString *sf ) {
    NSArray *cached = pathCache[sf];
    if ( cached ) return cached;
    NSMutableArray *path = [NSMutableArray new];
    NSString *frameId = sf;
    for ( int guard = 0; frameId && guard < 4096; guard++ ) {
      NSDictionary *frame = frames[frameId];
      if ( ![frame isKindOfClass:[NSDictionary class]] || [frame[@"category"] isEqual:@"root"] ) break;
      [path insertObject:@[functionName( frame ), shortFrameName( [frame[@"name"] description] ?: @"?" )]
                 atIndex:0];
      id parent = frame[@"parent"];
      frameId = parent ? [NSString stringWithFormat:@"%lld", [parent longLongValue]] : nil;
    }
    pathCache[sf] = path;
    return path;
  };
  for ( NSDictionary *sample in trace[@"samples"] ) {
    if ( ![sample isKindOfClass:[NSDictionary class]] ) continue;
    NSString *sf = [sample[@"sf"] description];
    NSInteger weight = MAX( 1, [sample[@"weight"] integerValue] );
    samples.total += weight;
    NSArray *path = sf ? pathOf( sf ) : @[];
    if ( path.count == 0 ) continue;
    samples.inJs += weight;
    addCount( samples.selfCounts, [path.lastObject firstObject], weight );
    NSMutableSet *seen = [NSMutableSet new];
    for ( NSArray *frame in path ) {
      if ( [seen containsObject:frame[0]] ) continue;
      [seen addObject:frame[0]];
      addCount( samples.totalCounts, frame[0], weight );
    }
    NSString *text = textCache[sf];
    if ( !text ) {
      text = stackText( path );
      textCache[sf] = text;
    }
    addCount( samples.stackCounts, text, weight );
  }
}
#endif

// Moves what Hermes has sampled since the last call into `samples`. These
// throw if Hermes was built without its sampling profiler.
static void collectSamples( INatJsSamples *samples )
{
#ifdef INAT_HAS_HERMES_PROFILER
  auto *api = hermesRoot();
  if ( !api || cpSamplingHz <= 0 ) return;
  try {
    std::stringstream stream;
    api->dumpSampledTraceToStream( stream );
    addTrace( stream.str(), samples );
  } catch ( ... ) {
  }
#endif
}

static void setSampling( double hz )
{
  if ( hz == cpSamplingHz ) return;
#ifdef INAT_HAS_HERMES_PROFILER
  auto *api = hermesRoot();
  if ( !api ) return;
  try {
    // Enabling while already enabled is ignored, so a rate change restarts it
    if ( cpSamplingHz > 0 ) api->disableSamplingProfiler();
    cpSamplingHz = 0;
    if ( hz > 0 ) {
      api->enableSamplingProfiler( hz );
      cpSamplingHz = hz;
    }
  } catch ( ... ) {
    cpSamplingHz = 0;
  }
#endif
}

static void startPeriod( void )
{
  cpPeriod = [INatJsSamples new];
  cpPeriodThreads = threadTimes();
  cpPeriodCpu = processCpuSeconds();
  cpPeriodStartedAt = CACurrentMediaTime();
  cpPeriodTicks = 0;
  cpPeriodScreens = [NSMutableDictionary new];
}

// What the JS thread spent the last stretch in front on, if it was busy
// enough to say
static void reportPeriod( void )
{
  if ( !cpPeriod ) return;
  if ( cpPeriod.inJs >= kMinSummaryJsSamples ) {
    double elapsed = MAX( 0.001, CACurrentMediaTime() - cpPeriodStartedAt );
    NSMutableDictionary *fields = [describeSamples( cpPeriod ) mutableCopy];
    fields[@"periodSec"] = @( round( elapsed ) );
    fields[@"sampleHz"] = @( kContinuousHz );
    fields[@"cpuPct"] = @( round( 100 * ( processCpuSeconds() - cpPeriodCpu ) / elapsed ) );
    // Share of samples that found JavaScript running
    fields[@"jsBusyPct"] = @( cpPeriod.total ? round( 100.0 * cpPeriod.inJs / cpPeriod.total ) : 0 );
    fields[@"threads"] = describeThreads( cpPeriodThreads, threadTimes(), elapsed );
    NSMutableString *screens = [NSMutableString new];
    for ( NSString *screen in sortedKeys( cpPeriodScreens ) ) {
      [screens appendFormat:@"%@: %lds\n", screen,
        (long) ( cpPeriodScreens[screen].integerValue * kTickSec )];
    }
    fields[@"screens"] = screens;
    cpReport( @"js_cpu_summary", fields );
  }
  startPeriod();
}

static void finishBurst( NSDictionary *before, double cpuBefore, double startedAt,
                         double windowCpuPct )
{
  INatJsSamples *burst = [INatJsSamples new];
  collectSamples( burst );
  NSMutableDictionary *fields = [describeSamples( burst ) mutableCopy];
#ifndef INAT_HAS_HERMES_PROFILER
  fields[@"profileError"] = @"built without the Hermes profiler";
#endif
  double elapsed = MAX( 0.001, CACurrentMediaTime() - startedAt );
  fields[@"windowCpuPct"] = @( round( windowCpuPct ) );
  fields[@"profileCpuPct"] = @( round( 100 * ( processCpuSeconds() - cpuBefore ) / elapsed ) );
  fields[@"profileSec"] = @( round( elapsed * 10 ) / 10 );
  fields[@"sampleHz"] = @( kBurstHz );
  fields[@"threads"] = describeThreads( before, threadTimes(), elapsed );
  fields[@"screen"] = INatPowerCurrentScreen() ?: @"";
  cpReport( @"cpu_profile", fields );
  setSampling( cpActive ? kContinuousHz : 0 );
  cpBursting = NO;
  cpBursts++;
  cpLastBurstAt = CACurrentMediaTime();
  cpTicks = 0;
}

static void startBurst( double windowCpuPct )
{
  cpBursting = YES;
  // Keep what the continuous profile has so far, then sample faster
  if ( cpPeriod ) collectSamples( cpPeriod );
  NSDictionary *before = threadTimes();
  double cpuBefore = processCpuSeconds();
  double startedAt = CACurrentMediaTime();
  setSampling( kBurstHz );
  dispatch_after( dispatch_time( DISPATCH_TIME_NOW, (int64_t) ( kBurstSec * NSEC_PER_SEC ) ),
                  cpQueue, ^{
    finishBurst( before, cpuBefore, startedAt, windowCpuPct );
  } );
}

static void tick( void )
{
  double now = processCpuSeconds();
  cpWindow[cpTicks % kWindowTicks] = now - cpLastCpu;
  cpLastCpu = now;
  cpTicks++;
  if ( cpActive && !cpBursting ) {
    cpPeriodTicks++;
    NSString *screen = INatPowerCurrentScreen();
    if ( screen ) addCount( cpPeriodScreens, screen, 1 );
    if ( cpPeriodTicks % kCollectTicks == 0 ) collectSamples( cpPeriod );
    if ( cpPeriodTicks >= kSummaryTicks ) reportPeriod();
  }
  if ( cpBursting || cpBursts >= kMaxBursts || cpTicks < kWindowTicks ) return;
  if ( cpLastBurstAt >= 0 && CACurrentMediaTime() - cpLastBurstAt < kCooldownSec ) return;
  double busy = 0;
  for ( int i = 0; i < kWindowTicks; i++ ) busy += cpWindow[i];
  double windowSec = kTickSec * kWindowTicks;
  if ( busy < kTriggerCores * windowSec ) return;
  startBurst( 100 * busy / windowSec );
}

static void appBecameActive( void )
{
  if ( cpActive ) return;
  cpActive = YES;
  startPeriod();
  if ( !cpBursting ) setSampling( kContinuousHz );
}

static void appLeftForeground( void )
{
  if ( !cpActive ) return;
  cpActive = NO;
  if ( cpBursting ) return; // the burst turns sampling off when it ends
  collectSamples( cpPeriod );
  setSampling( 0 );
  reportPeriod();
  cpPeriod = nil;
}

void INatStartCpuWatchdog( INatCpuReport report )
{
#if DEBUG
  return;
#else
  if ( cpTimer ) return;
  cpReport = [report copy];
  cpMainThread = pthread_self();
  cpQueue = dispatch_queue_create( "org.inaturalist.cpuwatchdog", DISPATCH_QUEUE_SERIAL );
  cpLastCpu = processCpuSeconds();
  cpTimer = dispatch_source_create( DISPATCH_SOURCE_TYPE_TIMER, 0, 0, cpQueue );
  // Generous leeway: the watchdog shouldn't be what keeps the CPU awake
  dispatch_source_set_timer( cpTimer,
    dispatch_time( DISPATCH_TIME_NOW, (int64_t) ( kTickSec * NSEC_PER_SEC ) ),
    (uint64_t) ( kTickSec * NSEC_PER_SEC ), (uint64_t) ( NSEC_PER_SEC ) );
  dispatch_source_set_event_handler( cpTimer, ^{ tick(); } );
  dispatch_resume( cpTimer );
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  [center addObserverForName:UIApplicationDidBecomeActiveNotification object:nil
                       queue:nil usingBlock:^( NSNotification *note ) {
    dispatch_async( cpQueue, ^{ appBecameActive(); } );
  }];
  [center addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil
                       queue:nil usingBlock:^( NSNotification *note ) {
    dispatch_async( cpQueue, ^{ appLeftForeground(); } );
  }];
#endif
}
