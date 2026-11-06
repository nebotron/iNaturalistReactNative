#import <Foundation/Foundation.h>

// Battery attribution through MetricKit signposts. Each activity named here
// is a MetricKit signpost interval, and iOS reports, once a day, the CPU time,
// disk writes, memory and hitches the whole process used while that interval
// was open. AppDelegate posts them to the app log as "metrickit_signpost".
//
// There are two kinds:
//
// - The screen (INatPowerSetScreen): exactly one interval is open at a time,
//   the screen in front while the app is active, or "Background" while it
//   isn't, so screens split foreground time between them and their CPU times
//   add up to the day's total.
// - Activities (INatPowerSetActivity) that run alongside a screen, such as
//   Audio ID listening, which carries on in the background. Their intervals
//   overlap the screen's, so their figures repeat part of a screen's.
//
// Safe to call from any thread.
void INatPowerSetScreen( NSString *_Nullable screen );
void INatPowerSetActivity( NSString *_Nonnull activity, BOOL active );
