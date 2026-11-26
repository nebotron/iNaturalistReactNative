#import <Foundation/Foundation.h>

// Names what the app is spending CPU on while it's happening, which
// MetricKit's CPU exceptions can't: they arrive a day later, and every
// JavaScript frame in them is the same Hermes interpreter loop.
//
// While the app is in front, Hermes's sampling profiler runs on the JS thread
// all the time at a low rate (a few samples a second), and every 15 minutes in
// front, and on going to the background, "js_cpu_summary" reports what the JS
// thread spent that time on: the functions with the most samples, of their own
// and under them, the heaviest stacks, and each thread's share of the CPU.
// Only when the JS was busy enough for the counts to mean something.
//
// Separately, a watchdog reads the process's CPU time every few seconds. When
// the app has kept more than about 60% of a core busy for half a minute, in
// front or not, it samples ten times faster for a few seconds and reports
// "cpu_profile", the same breakdown for those seconds.
//
// Function names survive in release bundles; the line:column positions are
// in main.jsbundle, for a source map of the same commit to place. Release
// builds only (it would take over a profile started from DevTools), and at
// most four bursts per launch, one every ten minutes.

typedef void ( ^INatCpuReport )( NSString *_Nonnull message, NSDictionary *_Nonnull fields );

// Call once, on the main thread.
void INatStartCpuWatchdog( INatCpuReport _Nonnull report );
