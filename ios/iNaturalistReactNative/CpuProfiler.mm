#import "CpuProfiler.h"
#import "PowerProfile.h"

#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>
#import <pthread.h>
#import <sys/resource.h>

#if __has_include(<hermes/hermes.h>)
#include <hermes/hermes.h>
#include <sstream>
#define INAT_HAS_HERMES_PROFILER 1
#endif

static const double kTickSec = 5;
static const int kWindowTicks = 6;         // 30 s
static const double kTriggerCores = 0.6;   // average share of one core over the window
static const double kProfileSec = 8;
static const double kSampleHz = 50;
static const double kCooldownSec = 10 * 60;
static const int kMaxReports = 4;

static dispatch_queue_t cpQueue;
static dispatch_source_t cpTimer;
static INatCpuReport cpReport;
static pthread_t cpMainThread;
static double cpLastCpu;
static double cpWindow[kWindowTicks];
static int cpTicks;
static BOOL cpProfiling;
static int cpReports;
static double cpLastReportAt = -1;

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

static void appendCounts( NSMutableString *out, NSString *title, NSDictionary *counts,
                          NSInteger total, NSUInteger limit )
{
  NSArray *keys = [counts keysSortedByValueUsingComparator:^( NSNumber *a, NSNumber *b ) {
    return [b compare:a];
  }];
  [out appendFormat:@"%@:\n", title];
  for ( NSUInteger i = 0; i < MIN( limit, keys.count ); i++ ) {
    NSInteger n = [counts[keys[i]] integerValue];
    [out appendFormat:@"  %5ld %4.1f%%  %@\n", (long) n, total ? 100.0 * n / total : 0.0, keys[i]];
  }
}

// Hermes's Chrome trace: samples point at a stack frame id, and each frame at
// its parent, up to "[root]".
static NSDictionary *summarizeTrace( const std::string &json )
{
  NSData *data = [NSData dataWithBytesNoCopy:(void *) json.data() length:json.size()
                                freeWhenDone:NO];
  NSDictionary *trace = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if ( ![trace isKindOfClass:[NSDictionary class]] ) return @{ @"profileError": @"unreadable trace" };
  NSDictionary *frames = trace[@"stackFrames"];
  NSArray *samples = trace[@"samples"];
  NSMutableDictionary<NSString *, NSArray *> *pathCache = [NSMutableDictionary new];
  // Root first, [root] left out; frames as @[function, positioned name]
  NSArray *( ^pathOf )( NSString * ) = ^NSArray *( NSString *sf ) {
    NSArray *cached = pathCache[sf];
    if ( cached ) return cached;
    NSMutableArray *path = [NSMutableArray new];
    NSString *id_ = sf;
    for ( int guard = 0; id_ && guard < 4096; guard++ ) {
      NSDictionary *frame = frames[id_];
      if ( ![frame isKindOfClass:[NSDictionary class]] || [frame[@"category"] isEqual:@"root"] ) break;
      [path insertObject:@[functionName( frame ), shortFrameName( [frame[@"name"] description] ?: @"?" )]
                 atIndex:0];
      id parent = frame[@"parent"];
      id_ = parent ? [NSString stringWithFormat:@"%lld", [parent longLongValue]] : nil;
    }
    pathCache[sf] = path;
    return path;
  };
  NSMutableDictionary<NSString *, NSNumber *> *selfCounts = [NSMutableDictionary new];
  NSMutableDictionary<NSString *, NSNumber *> *totalCounts = [NSMutableDictionary new];
  NSMutableDictionary<NSString *, NSNumber *> *stackCounts = [NSMutableDictionary new];
  NSInteger total = 0, inJs = 0;
  for ( NSDictionary *sample in samples ) {
    if ( ![sample isKindOfClass:[NSDictionary class]] ) continue;
    NSString *sf = [sample[@"sf"] description];
    NSInteger weight = MAX( 1, [sample[@"weight"] integerValue] );
    total += weight;
    NSArray *path = sf ? pathOf( sf ) : @[];
    if ( path.count == 0 ) continue;
    inJs += weight;
    NSString *leaf = [path.lastObject firstObject];
    selfCounts[leaf] = @( selfCounts[leaf].integerValue + weight );
    NSMutableSet *seen = [NSMutableSet new];
    for ( NSArray *frame in path ) {
      if ( [seen containsObject:frame[0]] ) continue;
      [seen addObject:frame[0]];
      totalCounts[frame[0]] = @( totalCounts[frame[0]].integerValue + weight );
    }
    stackCounts[sf] = @( stackCounts[sf].integerValue + weight );
  }
  NSMutableString *out = [NSMutableString new];
  appendCounts( out, @"JS top self", selfCounts, inJs, 30 );
  appendCounts( out, @"JS top inclusive", totalCounts, inJs, 30 );
  NSArray *stacks = [stackCounts keysSortedByValueUsingComparator:^( NSNumber *a, NSNumber *b ) {
    return [b compare:a];
  }];
  [out appendString:@"JS heaviest stacks (leaf first):\n"];
  for ( NSUInteger i = 0; i < MIN( (NSUInteger) 10, stacks.count ); i++ ) {
    NSInteger n = stackCounts[stacks[i]].integerValue;
    [out appendFormat:@"  [%ld samples, %.1f%%]\n", (long) n, inJs ? 100.0 * n / inJs : 0.0];
    NSArray *leafFirst = pathOf( stacks[i] ).reverseObjectEnumerator.allObjects;
    const NSUInteger leafKept = 20, rootKept = 8;
    for ( NSUInteger j = 0; j < leafFirst.count; j++ ) {
      if ( leafFirst.count > leafKept + rootKept && j == leafKept ) {
        [out appendFormat:@"    ... %lu frames ...\n",
          (unsigned long) ( leafFirst.count - leafKept - rootKept )];
        j = leafFirst.count - rootKept;
      }
      [out appendFormat:@"    %@\n", leafFirst[j][1]];
    }
  }
  if ( out.length > 40000 ) [out setString:[out substringToIndex:40000]];
  return @{
    @"samples": @( total ),
    // Samples that found the JS thread running JavaScript; the rest were
    // outside it (native work, or idle)
    @"jsSamples": @( inJs ),
    @"profile": out,
  };
}
#endif

static void finishProfile( NSDictionary *before, double cpuBefore, double startedAt,
                           double windowCpuPct )
{
  NSMutableDictionary *fields = [NSMutableDictionary new];
#ifdef INAT_HAS_HERMES_PROFILER
  auto *api = hermesRoot();
  if ( api ) {
    api->disableSamplingProfiler();
    std::stringstream stream;
    api->dumpSampledTraceToStream( stream );
    [fields addEntriesFromDictionary:summarizeTrace( stream.str() )];
  }
#else
  fields[@"profileError"] = @"built without the Hermes profiler";
#endif
  double elapsed = MAX( 0.001, CACurrentMediaTime() - startedAt );
  fields[@"windowCpuPct"] = @( round( windowCpuPct ) );
  fields[@"profileCpuPct"] = @( round( 100 * ( processCpuSeconds() - cpuBefore ) / elapsed ) );
  fields[@"profileSec"] = @( round( elapsed * 10 ) / 10 );
  fields[@"sampleHz"] = @( kSampleHz );
  fields[@"threads"] = describeThreads( before, threadTimes(), elapsed );
  fields[@"screen"] = INatPowerCurrentScreen() ?: @"";
  cpReport( @"cpu_profile", fields );
  cpProfiling = NO;
  cpReports++;
  cpLastReportAt = CACurrentMediaTime();
  cpTicks = 0;
}

static void startProfile( double windowCpuPct )
{
  cpProfiling = YES;
  NSDictionary *before = threadTimes();
  double cpuBefore = processCpuSeconds();
  double startedAt = CACurrentMediaTime();
#ifdef INAT_HAS_HERMES_PROFILER
  auto *api = hermesRoot();
  if ( api ) api->enableSamplingProfiler( kSampleHz );
#endif
  dispatch_after( dispatch_time( DISPATCH_TIME_NOW, (int64_t) ( kProfileSec * NSEC_PER_SEC ) ),
                  cpQueue, ^{
    finishProfile( before, cpuBefore, startedAt, windowCpuPct );
  } );
}

static void tick( void )
{
  double now = processCpuSeconds();
  cpWindow[cpTicks % kWindowTicks] = now - cpLastCpu;
  cpLastCpu = now;
  cpTicks++;
  if ( cpProfiling || cpReports >= kMaxReports || cpTicks < kWindowTicks ) return;
  if ( cpLastReportAt >= 0 && CACurrentMediaTime() - cpLastReportAt < kCooldownSec ) return;
  double busy = 0;
  for ( int i = 0; i < kWindowTicks; i++ ) busy += cpWindow[i];
  double windowSec = kTickSec * kWindowTicks;
  if ( busy < kTriggerCores * windowSec ) return;
  startProfile( 100 * busy / windowSec );
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
#endif
}
