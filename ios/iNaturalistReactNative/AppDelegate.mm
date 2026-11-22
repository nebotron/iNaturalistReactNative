#import "AppDelegate.h"
#import "CpuProfiler.h"
#import "LocationRelaunch.h"

#import <Firebase.h>
#import <React/RCTBridge.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTHTTPRequestHandler.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <RNShareMenu/ShareMenuManager.h>
#import <React/RCTLinkingManager.h>
#import <QuartzCore/QuartzCore.h>
#import <MetricKit/MetricKit.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#import <mach-o/dyld.h>
#include <algorithm>
#include <vector>
#import <react/featureflags/ReactNativeFeatureFlags.h>
#import <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>
#if __has_include(<react_native_config/RNCConfig.h>)
#import <react_native_config/RNCConfig.h>
#else
#import "RNCConfig.h"
#endif

RCT_EXTERN NSArray<Class> *RCTGetModuleClasses( void );

// RN creates a main-queue-setup native module lazily on whichever thread first
// asks for it, by dispatch_sync'ing to the main queue. If the main thread asks
// for the same module meanwhile, it waits on the creating thread and both
// block for good: the watchdog kills behind every metrickit_crash. Creating
// all of those modules on the main queue before JS runs removes the race.
class INatFeatureFlags : public facebook::react::ReactNativeFeatureFlagsOverridesOSSStable {
 public:
  bool enableEagerMainQueueModulesOnIOS() override { return true; }
};

@interface AppDelegate () <MXMetricManagerSubscriber>
@property (nonatomic, copy, nullable) NSDictionary *appLaunchOptions;
// Kept so a scene that reconnects after iOS discarded the last one shows the
// same React Native root instead of starting a second one
@property (nonatomic, strong, nullable) UIViewController *reactRootViewController;
@end

// MetricKit's stack JSON names frames only by binary UUID and nests one level per
// frame, so the raw JSON cut to the log's size limit never reached the leaf
// frames. Flatten each thread to leaf-first lines, naming the binary and the
// nearest symbol dladdr finds for frames in images loaded in this process.
static NSDictionary<NSString *, NSValue *> *loadedImagesByUUID( void )
{
  NSMutableDictionary *images = [NSMutableDictionary new];
  for ( uint32_t i = 0; i < _dyld_image_count(); i++ ) {
    const struct mach_header_64 *header =
      (const struct mach_header_64 *) _dyld_get_image_header( i );
    const struct load_command *cmd = (const struct load_command *) ( header + 1 );
    for ( uint32_t c = 0; c < header->ncmds; c++ ) {
      if ( cmd->cmd == LC_UUID ) {
        NSUUID *uuid = [[NSUUID alloc]
          initWithUUIDBytes:( (const struct uuid_command *) cmd )->uuid];
        images[uuid.UUIDString] = [NSValue valueWithPointer:header];
        break;
      }
      cmd = (const struct load_command *) ( (const char *) cmd + cmd->cmdsize );
    }
  }
  return images;
}

// One frame as "image symbol+offset (+0xoffset)", or "image+0xoffset" where
// dladdr knows no symbol (the app's own frames in a build without symbols,
// which scripts/symbolicate.py names from the offset).
static NSString *describeFrame( NSDictionary *f, NSDictionary *images )
{
  NSString *uuid = f[@"binaryUUID"];
  uint64_t offset = [f[@"offsetIntoBinaryTextSegment"] unsignedLongLongValue];
  const char *address = (const char *) [images[uuid] pointerValue];
  NSString *where = [NSString stringWithFormat:@"%@+0x%llx",
    f[@"binaryName"] ?: [uuid substringToIndex:MIN( uuid.length, 8 )], offset];
  Dl_info info;
  if ( address && dladdr( address + offset, &info ) ) {
    NSString *image = [@( info.dli_fname ?: "" ) lastPathComponent];
    where = info.dli_sname
      ? [NSString stringWithFormat:@"%@ %s+%ld (+0x%llx)", image, info.dli_sname,
          (long) ( address + offset - (const char *) info.dli_saddr ), offset]
      : [NSString stringWithFormat:@"%@+0x%llx", image, offset];
  }
  return where;
}

static NSDictionary *parseStackTree( MXCallStackTree *stack )
{
  NSDictionary *tree = [NSJSONSerialization JSONObjectWithData:[stack JSONRepresentation]
                                                       options:0 error:nil];
  return [tree isKindOfClass:[NSDictionary class]] ? tree : nil;
}

// A crash or hang: one stack per thread, leaf first.
static NSString *describeStack( MXCallStackTree *stack )
{
  NSDictionary *tree = parseStackTree( stack );
  if ( !tree ) return nil;
  NSDictionary *images = loadedImagesByUUID();
  NSMutableString *out = [NSMutableString new];
  NSInteger threadIndex = 0;
  for ( NSDictionary *thread in tree[@"callStacks"] ) {
    NSMutableArray *frames = [NSMutableArray new];
    NSDictionary *frame = [thread[@"callStackRootFrames"] firstObject];
    while ( frame ) {
      [frames addObject:frame];
      // Follow the most-sampled branch, which for a crash is the only one
      NSDictionary *next = nil;
      for ( NSDictionary *sub in frame[@"subFrames"] ) {
        if ( !next || [sub[@"sampleCount"] integerValue] > [next[@"sampleCount"] integerValue] ) {
          next = sub;
        }
      }
      frame = next;
    }
    [out appendFormat:@"thread %ld%@:\n", (long) threadIndex++,
      [thread[@"threadAttributed"] boolValue] ? @" (attributed)" : @""];
    NSInteger shown = 0;
    for ( NSDictionary *f in frames.reverseObjectEnumerator ) {
      if ( shown++ >= 40 ) break;
      [out appendFormat:@"  %@\n", describeFrame( f, images )];
    }
  }
  return out;
}

// What a sampled stack spent its samples on. CPU and disk-write exceptions
// are a tree of samples, and following only the heaviest branch (as for a
// crash) showed one path of many, cut off 40 frames from the leaf, before
// the callers that say which feature it was. This reports every thread's
// share, the functions with the most samples of their own (self) and under
// them (inclusive), and the heaviest distinct stacks whole, with the root end
// kept when the middle is elided.
namespace {
struct SampledPath {
  NSInteger count;
  NSArray<NSString *> *frames; // root first
  NSInteger thread;
};
}

static void walkSampled( NSDictionary *frame, NSDictionary *images, NSInteger thread,
                         NSMutableArray<NSString *> *path,
                         NSCountedSet *pathLabels,
                         NSMutableDictionary<NSString *, NSNumber *> *selfCounts,
                         NSMutableDictionary<NSString *, NSNumber *> *totalCounts,
                         std::vector<SampledPath> &paths )
{
  NSString *label = describeFrame( frame, images );
  NSInteger count = [frame[@"sampleCount"] integerValue];
  NSInteger inChildren = 0;
  for ( NSDictionary *sub in frame[@"subFrames"] ) inChildren += [sub[@"sampleCount"] integerValue];
  // Recursion would count a function's samples once per level
  if ( [pathLabels countForObject:label] == 0 ) {
    totalCounts[label] = @( totalCounts[label].integerValue + count );
  }
  [path addObject:label];
  [pathLabels addObject:label];
  NSInteger own = MAX( 0, count - inChildren );
  if ( own > 0 ) {
    selfCounts[label] = @( selfCounts[label].integerValue + own );
    paths.push_back( { own, [path copy], thread } );
  }
  for ( NSDictionary *sub in frame[@"subFrames"] ) {
    walkSampled( sub, images, thread, path, pathLabels, selfCounts, totalCounts, paths );
  }
  [path removeLastObject];
  [pathLabels removeObject:label];
}

static void appendTop( NSMutableString *out, NSString *title,
                       NSDictionary<NSString *, NSNumber *> *counts, NSInteger total,
                       NSUInteger limit )
{
  NSArray *labels = [counts keysSortedByValueUsingComparator:^( NSNumber *a, NSNumber *b ) {
    return [b compare:a];
  }];
  [out appendFormat:@"%@:\n", title];
  for ( NSUInteger i = 0; i < MIN( limit, labels.count ); i++ ) {
    NSInteger n = counts[labels[i]].integerValue;
    [out appendFormat:@"  %5ld %4.1f%%  %@\n", (long) n,
      total ? 100.0 * n / total : 0.0, labels[i]];
  }
}

static NSString *describeSampledStack( MXCallStackTree *stack )
{
  NSDictionary *tree = parseStackTree( stack );
  if ( !tree ) return nil;
  NSDictionary *images = loadedImagesByUUID();
  NSMutableDictionary *selfCounts = [NSMutableDictionary new];
  NSMutableDictionary *totalCounts = [NSMutableDictionary new];
  std::vector<SampledPath> paths;
  NSMutableString *threads = [NSMutableString new];
  NSInteger total = 0;
  NSInteger threadIndex = 0;
  for ( NSDictionary *thread in tree[@"callStacks"] ) {
    NSInteger threadSamples = 0;
    for ( NSDictionary *root in thread[@"callStackRootFrames"] ) {
      threadSamples += [root[@"sampleCount"] integerValue];
      walkSampled( root, images, threadIndex, [NSMutableArray new], [NSCountedSet new],
                   selfCounts, totalCounts, paths );
    }
    total += threadSamples;
    [threads appendFormat:@"  thread %ld%@: %ld samples\n", (long) threadIndex,
      [thread[@"threadAttributed"] boolValue] ? @" (attributed)" : @"", (long) threadSamples];
    threadIndex++;
  }
  NSMutableString *out = [NSMutableString new];
  [out appendFormat:@"samples: %ld\n%@", (long) total, threads];
  appendTop( out, @"top self", selfCounts, total, 25 );
  appendTop( out, @"top inclusive", totalCounts, total, 25 );
  std::sort( paths.begin(), paths.end(), []( const SampledPath &a, const SampledPath &b ) {
    return a.count > b.count;
  } );
  [out appendString:@"heaviest stacks (leaf first):\n"];
  for ( size_t i = 0; i < MIN( (size_t) 8, paths.size() ); i++ ) {
    const SampledPath &p = paths[i];
    [out appendFormat:@"  [%ld samples, %.1f%%, thread %ld]\n", (long) p.count,
      total ? 100.0 * p.count / total : 0.0, (long) p.thread];
    NSArray *leafFirst = p.frames.reverseObjectEnumerator.allObjects;
    const NSUInteger leafKept = 24, rootKept = 12;
    for ( NSUInteger j = 0; j < leafFirst.count; j++ ) {
      if ( leafFirst.count > leafKept + rootKept && j == leafKept ) {
        [out appendFormat:@"    ... %lu frames ...\n",
          (unsigned long) ( leafFirst.count - leafKept - rootKept )];
        j = leafFirst.count - rootKept;
      }
      [out appendFormat:@"    %@\n", leafFirst[j]];
    }
  }
  return out;
}

// iOS's own reports of the crashes and hangs the JS handlers can't see: signals
// (EXC_BAD_ACCESS and the like), watchdog kills, and main-thread hangs. MetricKit
// hands over the previous launches' reports at the next launch, and they go
// straight to the app log from here, so a launch that dies before JS logs
// anything is still on the record.
static void postDiagnostic( NSString *message, NSDictionary *fields, MXCallStackTree *stack,
                            NSString *level = @"error", BOOL sampled = NO )
{
  NSString *base = [RNCConfig envFor:@"CROP_LOG_FIREBASE_URL"];
  if ( base.length == 0 ) return;
  NSMutableDictionary *entry = [fields mutableCopy];
  NSISO8601DateFormatter *iso = [NSISO8601DateFormatter new];
  iso.formatOptions |= NSISO8601DateFormatWithFractionalSeconds;
  entry[@"timestamp"] = [iso stringFromDate:[NSDate date]];
  entry[@"level"] = level;
  entry[@"extension"] = @"MetricKit";
  entry[@"commit"] = [NSString stringWithFormat:@"build-%@",
    [NSBundle mainBundle].infoDictionary[@"CFBundleVersion"]];
  entry[@"message"] = message;
  NSString *stackText = nil;
  if ( stack ) stackText = sampled ? describeSampledStack( stack ) : describeStack( stack );
  if ( stackText.length > 60000 ) stackText = [stackText substringToIndex:60000];
  if ( stackText ) entry[@"stack"] = stackText;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:
    [NSURL URLWithString:[base stringByAppendingString:@"/app_log.json"]]];
  request.HTTPMethod = @"POST";
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:entry options:0 error:nil];
  [[[NSURLSession sharedSession] dataTaskWithRequest:request] resume];
}

static NSString *describe( id value )
{
  return value ? [NSString stringWithFormat:@"%@", value] : @"";
}

// A MetricKit measurement as a plain number in `unit`, or -1 when absent.
static NSNumber *measure( NSMeasurement *value, NSUnit *unit )
{
  return value ? @( round( [value measurementByConvertingToUnit:unit].doubleValue * 10 ) / 10 )
               : @( -1 );
}

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

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  // Required for react-native-firebase: https://rnfirebase.io/#configure-firebase-with-ios-credentials-react-native--077
  @try {
    [FIRApp configure];
  } @catch (NSException *exception) {
    NSLog(@"Skipping Firebase configuration due to invalid local GoogleService-Info.plist: %@", exception.reason);
  }
  // Explore's results come back after a restart, and offline, from the HTTP
  // cache rather than a copy the JS makes (see useAuthenticatedInfiniteQuery).
  // Set before React Native's session is made, which takes the shared cache.
  NSURLCache.sharedURLCache = [[NSURLCache alloc] initWithMemoryCapacity:4 * 1024 * 1024
                                                            diskCapacity:50 * 1024 * 1024
                                                            directoryURL:nil];
  // Offline, a request asks for "Cache-Control: only-if-cached": whatever the
  // cache holds, however old, and no network. OkHttp does that on Android;
  // NSURLSession ignores request cache directives, so map it to the policy
  // that does the same.
  RCTSetCustomHTTPRequestInterceptor( ^NSURLRequest *( NSURLRequest *request ) {
    NSString *cacheControl = [request valueForHTTPHeaderField:@"Cache-Control"];
    if ( ![cacheControl containsString:@"only-if-cached"] ) return nil;
    NSMutableURLRequest *fromCache = [request mutableCopy];
    fromCache.cachePolicy = NSURLRequestReturnCacheDataDontLoad;
    [fromCache setValue:nil forHTTPHeaderField:@"Cache-Control"];
    return fromCache;
  } );
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self];
  facebook::react::ReactNativeFeatureFlags::dangerouslyForceOverride(
    std::make_unique<INatFeatureFlags>() );
  self.dependencyProvider = [RCTAppDependencyProvider new];
  // React Native starts when the scene connects (SceneDelegate), since a
  // window needs a scene to show in
  self.appLaunchOptions = launchOptions;

  // Resume location monitoring when the user had location history tracking
  // enabled, or when iOS relaunched us because of a location event. Starting
  // here rather than waiting for JS means a background relaunch resumes the
  // continuous watch immediately, and significant-change monitoring keeps the
  // app relaunchable after iOS terminates it - which is what prevents
  // multi-hour gaps in the tracked history, since a standard-location watch
  // alone cannot relaunch a killed app.
  if ( launchOptions[UIApplicationLaunchOptionsLocationKey] || [INatLocationMonitor enabled] ) {
    [[INatLocationMonitor shared] start];
  }

  [[MXMetricManager sharedManager] addSubscriber:self];
  INatStartCpuWatchdog( ^( NSString *message, NSDictionary *fields ) {
    postDiagnostic( message, fields, nil, @"warn" );
  } );

  return YES;
}

- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads
{
  for ( MXDiagnosticPayload *payload in payloads ) {
    for ( MXCrashDiagnostic *crash in payload.crashDiagnostics ) {
      postDiagnostic( @"metrickit_crash", @{
        @"appBuild": describe( crash.metaData.applicationBuildVersion ),
        @"exceptionType": describe( crash.exceptionType ),
        @"exceptionCode": describe( crash.exceptionCode ),
        @"signal": describe( crash.signal ),
        @"terminationReason": describe( crash.terminationReason ),
        @"vmRegion": describe( crash.virtualMemoryRegionInfo ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, crash.callStackTree );
    }
    for ( MXHangDiagnostic *hang in payload.hangDiagnostics ) {
      postDiagnostic( @"metrickit_hang", @{
        @"appBuild": describe( hang.metaData.applicationBuildVersion ),
        @"hangDuration": describe( hang.hangDuration ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, hang.callStackTree );
    }
    // iOS reports these when the app burns more CPU than it allows over a
    // window (~80% for a minute); the stack shows where it went.
    for ( MXCPUExceptionDiagnostic *cpu in payload.cpuExceptionDiagnostics ) {
      postDiagnostic( @"metrickit_cpu_exception", @{
        @"appBuild": describe( cpu.metaData.applicationBuildVersion ),
        @"cpuSeconds": measure( cpu.totalCPUTime, NSUnitDuration.seconds ),
        @"sampledSeconds": measure( cpu.totalSampledTime, NSUnitDuration.seconds ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, cpu.callStackTree, @"warn", YES );
    }
    // iOS reports these when the app writes more than 1 GB to disk in a day;
    // the stack shows which code did the writing.
    for ( MXDiskWriteExceptionDiagnostic *disk in payload.diskWriteExceptionDiagnostics ) {
      postDiagnostic( @"metrickit_disk_write_exception", @{
        @"appBuild": describe( disk.metaData.applicationBuildVersion ),
        @"writesMB": measure( disk.totalWritesCaused, NSUnitInformationStorage.megabytes ),
        @"from": describe( payload.timeStampBegin ),
        @"to": describe( payload.timeStampEnd ),
      }, disk.callStackTree, @"warn", YES );
    }
  }
}

// Total time a signpost interval was open, from its duration histogram: each
// bucket's count at the bucket's midpoint.
static NSNumber *histogramSeconds( MXHistogram<NSUnitDuration *> *histogram )
{
  if ( !histogram ) return @( -1 );
  double total = 0;
  for ( MXHistogramBucket<NSUnitDuration *> *bucket in histogram.bucketEnumerator ) {
    double start = [bucket.bucketStart measurementByConvertingToUnit:NSUnitDuration.seconds]
      .doubleValue;
    double end = [bucket.bucketEnd measurementByConvertingToUnit:NSUnitDuration.seconds]
      .doubleValue;
    total += bucket.bucketCount * ( start + end ) / 2;
  }
  return @( round( total * 10 ) / 10 );
}

// One a day per device: what the app spent on the things that drain the
// battery, so a change's effect on power can be compared across builds from the
// app log. Seconds and megabytes, -1 where iOS reported nothing.
- (void)didReceiveMetricPayloads:(NSArray<MXMetricPayload *> *)payloads
{
  NSUnitDuration *sec = NSUnitDuration.seconds;
  NSUnitInformationStorage *mb = NSUnitInformationStorage.megabytes;
  for ( MXMetricPayload *p in payloads ) {
    // iOS also delivers payloads spanning no time, with every metric missing
    if ( ![p.timeStampEnd timeIntervalSinceDate:p.timeStampBegin] ) continue;
    MXLocationActivityMetric *loc = p.locationActivityMetrics;
    MXNetworkTransferMetric *net = p.networkTransferMetrics;
    MXAppRunTimeMetric *run = p.applicationTimeMetrics;
    // Why the app ended: iOS kills it at its memory limit without a crash
    // report, so these counts are the only record of those kills.
    MXForegroundExitData *fgExit = p.applicationExitMetrics.foregroundExitData;
    MXBackgroundExitData *bgExit = p.applicationExitMetrics.backgroundExitData;
    postDiagnostic( @"metrickit_daily", @{
      @"appBuild": describe( p.metaData.applicationBuildVersion ),
      @"multipleVersions": @( p.includesMultipleApplicationVersions ),
      @"from": describe( p.timeStampBegin ),
      @"to": describe( p.timeStampEnd ),
      @"cpuSeconds": measure( p.cpuMetrics.cumulativeCPUTime, sec ),
      @"gpuSeconds": measure( p.gpuMetrics.cumulativeGPUTime, sec ),
      @"foregroundSeconds": measure( run.cumulativeForegroundTime, sec ),
      @"backgroundSeconds": measure( run.cumulativeBackgroundTime, sec ),
      @"backgroundAudioSeconds": measure( run.cumulativeBackgroundAudioTime, sec ),
      @"backgroundLocationSeconds": measure( run.cumulativeBackgroundLocationTime, sec ),
      @"locationBestSeconds": measure( loc.cumulativeBestAccuracyTime, sec ),
      @"locationNavigationSeconds": measure( loc.cumulativeBestAccuracyForNavigationTime, sec ),
      @"location10mSeconds": measure( loc.cumulativeNearestTenMetersAccuracyTime, sec ),
      @"location100mSeconds": measure( loc.cumulativeHundredMetersAccuracyTime, sec ),
      @"location1kmSeconds": measure( loc.cumulativeKilometerAccuracyTime, sec ),
      @"location3kmSeconds": measure( loc.cumulativeThreeKilometersAccuracyTime, sec ),
      @"wifiUpMB": measure( net.cumulativeWifiUpload, mb ),
      @"wifiDownMB": measure( net.cumulativeWifiDownload, mb ),
      @"cellUpMB": measure( net.cumulativeCellularUpload, mb ),
      @"cellDownMB": measure( net.cumulativeCellularDownload, mb ),
      @"diskWritesMB": measure( p.diskIOMetrics.cumulativeLogicalWrites, mb ),
      @"displayLuminanceAPL": measure( p.displayMetrics.averagePixelLuminance.averageMeasurement,
                                       MXUnitAveragePixelLuminance.apl ),
      @"peakMemoryMB": measure( p.memoryMetrics.peakMemoryUsage, mb ),
      @"fgMemoryLimitExits": @( fgExit.cumulativeMemoryResourceLimitExitCount ),
      @"fgWatchdogExits": @( fgExit.cumulativeAppWatchdogExitCount ),
      @"bgMemoryLimitExits": @( bgExit.cumulativeMemoryResourceLimitExitCount ),
      @"bgMemoryPressureExits": @( bgExit.cumulativeMemoryPressureExitCount ),
      @"bgWatchdogExits": @( bgExit.cumulativeAppWatchdogExitCount ),
    }, nil, @"info" );
    // Where the day's CPU time and disk writes went: one entry per screen
    // and activity PowerProfile marked (see PowerProfile.h). Each figure is
    // the whole process's while that interval was open.
    for ( MXSignpostMetric *signpost in p.signpostMetrics ) {
      MXSignpostIntervalData *data = signpost.signpostIntervalData;
      postDiagnostic( @"metrickit_signpost", @{
        @"appBuild": describe( p.metaData.applicationBuildVersion ),
        @"from": describe( p.timeStampBegin ),
        @"to": describe( p.timeStampEnd ),
        @"category": signpost.signpostCategory,
        @"name": signpost.signpostName,
        @"count": @( signpost.totalCount ),
        @"seconds": histogramSeconds( data.histogrammedSignpostDuration ),
        @"cpuSeconds": measure( data.cumulativeCPUTime, sec ),
        @"diskWritesMB": measure( data.cumulativeLogicalWrites, mb ),
        @"averageMemoryMB": measure( data.averageMemory.averageMeasurement, mb ),
        @"hitchMsPerSecond": data.cumulativeHitchTimeRatio
          ? @( round( data.cumulativeHitchTimeRatio.doubleValue * 10 ) / 10 )
          : @( -1 ),
      }, nil, @"info" );
    }
  }
}

// Mirrors RCTTurboModuleManager's _requiresMainQueueSetup:, so every module RN
// would set up on the main queue is created there eagerly (see INatFeatureFlags).
- (NSArray<NSString *> *)unstableModulesRequiringMainQueueSetup
{
  NSMutableArray<NSString *> *names = [[super unstableModulesRequiringMainQueueSetup] mutableCopy];
  IMP objectInit = [NSObject instanceMethodForSelector:@selector( init )];
  for ( Class moduleClass in RCTGetModuleClasses() ) {
    BOOL requiresMainQueue = [moduleClass respondsToSelector:@selector( requiresMainQueueSetup )]
      ? [moduleClass requiresMainQueueSetup]
      : [moduleClass instancesRespondToSelector:@selector( constantsToExport )]
        || [moduleClass instanceMethodForSelector:@selector( init )] != objectInit;
    if ( requiresMainQueue ) [names addObject:RCTBridgeModuleNameForClass( moduleClass )];
  }
  return names;
}

- (void)showReactNativeInWindow:(UIWindow *)window
             sceneLaunchOptions:(NSDictionary *)sceneLaunchOptions
{
  self.window = window;
  if ( self.reactRootViewController ) {
    // The previous window is gone with its scene; free the controller for this one
    self.reactRootViewController.view.window.rootViewController = nil;
    window.rootViewController = self.reactRootViewController;
    [window makeKeyAndVisible];
    return;
  }
  NSMutableDictionary *options =
    [NSMutableDictionary dictionaryWithDictionary:self.appLaunchOptions ?: @{}];
  [options addEntriesFromDictionary:sceneLaunchOptions];
  [self.reactNativeFactory startReactNativeWithModuleName:@"iNaturalistReactNative"
                                                 inWindow:window
                                        initialProperties:@{}
                                            launchOptions:options];
  self.reactRootViewController = window.rootViewController;
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

// With the scene lifecycle, UIKit sends opened URLs and user activities to the
// scene rather than to the app delegate, and the ones a cold launch was opened
// with arrive in the connection options instead of the app's launch options.
static NSDictionary<UIApplicationOpenURLOptionsKey, id> *openURLOptions( UIOpenURLContext *context )
{
  NSMutableDictionary *options = [NSMutableDictionary new];
  if ( context.options.sourceApplication ) {
    options[UIApplicationOpenURLOptionsSourceApplicationKey] = context.options.sourceApplication;
  }
  if ( context.options.annotation ) {
    options[UIApplicationOpenURLOptionsAnnotationKey] = context.options.annotation;
  }
  options[UIApplicationOpenURLOptionsOpenInPlaceKey] = @( context.options.openInPlace );
  return options;
}

// https://reactnative.dev/docs/linking#get-the-deep-link
static void openURLContexts( NSSet<UIOpenURLContext *> *contexts )
{
  UIApplication *app = [UIApplication sharedApplication];
  for ( UIOpenURLContext *context in contexts ) {
    // Hands the URL to both the share extension's handler and RN's Linking;
    // ShareMenu holds a share that arrives before its module exists
    [ShareMenuManager application:app openURL:context.URL options:openURLOptions( context )];
  }
}

static void continueUserActivity( NSUserActivity *userActivity )
{
  [RCTLinkingManager application:[UIApplication sharedApplication]
            continueUserActivity:userActivity
              restorationHandler:^( NSArray<id<UIUserActivityRestoring>> *_Nullable objects ) {}];
}

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions
{
  if ( ![scene isKindOfClass:[UIWindowScene class]] ) return;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];

  // RN's Linking.getInitialURL reads these from the launch options, and a
  // URL event sent now would arrive before JS listens for it
  NSMutableDictionary *sceneLaunchOptions = [NSMutableDictionary new];
  NSURL *url = connectionOptions.URLContexts.anyObject.URL;
  if ( url ) sceneLaunchOptions[UIApplicationLaunchOptionsURLKey] = url;
  NSUserActivity *activity = connectionOptions.userActivities.anyObject;
  if ( activity ) {
    sceneLaunchOptions[UIApplicationLaunchOptionsUserActivityDictionaryKey] = @{
      UIApplicationLaunchOptionsUserActivityTypeKey: activity.activityType,
      @"UIApplicationLaunchOptionsUserActivityKey": activity,
    };
  }

  AppDelegate *appDelegate = (AppDelegate *) [UIApplication sharedApplication].delegate;
  [appDelegate showReactNativeInWindow:self.window sceneLaunchOptions:sceneLaunchOptions];

  // Shared photos come in by URL: ShareMenu keeps one that arrives before
  // its module exists and hands it to getInitialShare
  openURLContexts( connectionOptions.URLContexts );
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  openURLContexts( URLContexts );
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  continueUserActivity( userActivity );
}

@end
