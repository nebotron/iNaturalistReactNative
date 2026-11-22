#import <Foundation/Foundation.h>

// Names what the app is spending CPU on while it's happening, which
// MetricKit's CPU exceptions can't: they arrive a day later, and every
// JavaScript frame in them is the same Hermes interpreter loop.
//
// A watchdog reads the process's CPU time every few seconds. When the app has
// kept more than about 60% of a core busy for half a minute, it runs Hermes's
// sampling profiler on the JS thread for a few seconds and reports
// "cpu_profile": each thread's share of the CPU over those seconds, the JS
// functions with the most samples, and the heaviest JS stacks. Function names
// survive in release bundles; the line:column positions are in main.jsbundle,
// for a source map of the same commit to place.
//
// Release builds only (it would take over a profile started from DevTools),
// a few reports per launch, and at most one every ten minutes.

typedef void ( ^INatCpuReport )( NSString *_Nonnull message, NSDictionary *_Nonnull fields );

// Call once, on the main thread.
void INatStartCpuWatchdog( INatCpuReport _Nonnull report );
