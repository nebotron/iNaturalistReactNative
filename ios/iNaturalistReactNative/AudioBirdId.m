#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreHaptics/CoreHaptics.h>
#import <mach/mach.h>
#import <os/lock.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTViewManager.h>
#import <UserNotifications/UserNotifications.h>
#include "onnxruntime_c_api.h"

// Live bird identification by sound. Taps the microphone, resamples to
// 32 kHz mono, keeps the most recent 5 s in a sliding window, and every second
// runs the bundled audio_id.onnx on it: BirdNET v3.0 (CC BY-SA 4.0, "Powered
// by BirdNET") cut down to the species iNaturalist has sound observations of,
// with its weights in audio_id.data<N> (scripts/bird_audio/birdnet/
// build_model.py). Scores go out only for the outputs JS asks for. Everything
// runs offline. The model contains its own
// spectrogram frontend, so the window goes in as raw samples and one
// probability per species comes out (multi-label: several birds can score
// high at once). Scores are emitted to JS as "AudioBirdIdScores".
// Listening continues with the app in the background (the "audio" background
// mode in Info.plist) and resumes after interruptions such as phone calls or
// other audio in the app (recording or playing a sound) stopping the engine.
// Restarts and their outcomes go to JS as "AudioBirdIdStatus" for the app log.

#define AB_SR       32000
#define AB_WIN      160000  // 5 s, BirdNET v3.0's input
#define AB_HIST     512000  // 16 s kept, for 15 s clips around a window saved up to 1 s late
#define AB_STEP     32000   // run every 1 s of new audio
#define AB_SPEC_HOP 400     // spectrogram columns, 80 per second
#define AB_SPEC_LOG2N 10
#define AB_SPEC_N   ( 1 << AB_SPEC_LOG2N ) // samples per FFT, 31.25 Hz bins
#define AB_SPEC_LO  8       // lowest bin shown, 250 Hz
#define AB_SPEC_H   376     // bins shown, up to 12 kHz
#define AB_SPEC_W   800     // columns shown, 10 s

// The live spectrogram, shared between the module, which adds a column for
// every AB_SPEC_HOP new samples, and AudioSpectrogram views, which draw it.
// Intensities are kept in a ring of columns.
static os_unfair_lock abSpecLock = OS_UNFAIR_LOCK_INIT;
static uint8_t  abSpecLevel[AB_SPEC_W][AB_SPEC_H]; // 0..255, low frequencies first
static NSInteger abSpecCount;                      // columns added so far

static void ABSpectrogramReset( void )
{
  os_unfair_lock_lock( &abSpecLock );
  memset( abSpecLevel, 0, sizeof( abSpecLevel ) );
  abSpecCount = 0;
  os_unfair_lock_unlock( &abSpecLock );
}

// One column from the AB_SPEC_N samples at `frame`: power of a Hann-windowed
// FFT, mapped from -100..-20 dB to 0..1, with faint noise dropped and contrast
// boosted as in Merlin.
static void ABSpectrogramPush( const float *frame )
{
  static FFTSetup fft;
  static float hann[AB_SPEC_N];
  static float re[AB_SPEC_N / 2], im[AB_SPEC_N / 2], power[AB_SPEC_N / 2];
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    fft = vDSP_create_fftsetup( AB_SPEC_LOG2N, kFFTRadix2 );
    vDSP_hann_window( hann, AB_SPEC_N, vDSP_HANN_DENORM );
  } );
  float windowed[AB_SPEC_N];
  vDSP_vmul( frame, 1, hann, 1, windowed, 1, AB_SPEC_N );
  DSPSplitComplex split = { re, im };
  vDSP_ctoz( (const DSPComplex *)windowed, 2, &split, 1, AB_SPEC_N / 2 );
  vDSP_fft_zrip( fft, &split, 1, AB_SPEC_LOG2N, FFT_FORWARD );
  vDSP_zvmags( &split, 1, power, 1, AB_SPEC_N / 2 );
  uint8_t col[AB_SPEC_H];
  for ( int b = 0; b < AB_SPEC_H; b++ ) {
    // zrip doubles the DFT, so this matches a sine's amplitude^2 / 4.
    float db = 10 * log10f( power[AB_SPEC_LO + b] / ( AB_SPEC_N * AB_SPEC_N ) + 1e-12f );
    float v = ( db + 100 ) / 80;
    col[b] = v > 0.1f ? (uint8_t)( 255 * powf( MIN( 1, ( v - 0.1f ) / 0.9f ), 1.5f ) ) : 0;
  }
  os_unfair_lock_lock( &abSpecLock );
  NSInteger x = abSpecCount % AB_SPEC_W;
  memcpy( abSpecLevel[x], col, AB_SPEC_H );
  abSpecCount++;
  os_unfair_lock_unlock( &abSpecLock );
}

@interface AudioBirdId : RCTEventEmitter <RCTBridgeModule, UNUserNotificationCenterDelegate>
@end

@implementation AudioBirdId {
  AVAudioEngine    *_engine;
  AVAudioConverter *_converter;
  AVAudioFormat    *_outFormat;
  float            *_window;
  NSInteger         _sinceRun;
  int64_t           _frames; // total samples received, to locate a run's window later
  NSInteger         _specPending;
  float             _level;
  BOOL              _busy;
  dispatch_queue_t  _bufferQueue;
  dispatch_queue_t  _inferQueue;
  OrtEnv           *_env;
  OrtSession       *_session;
  NSArray<NSNumber *> *_outputs;
  OrtSession       *_geoSession;
  BOOL              _wantListening;
  dispatch_source_t _watchdog;
  CHHapticEngine   *_haptics;
  CFAbsoluteTime    _lastAudio;
  NSInteger         _restartFailures;
  BOOL              _playingClip;
}

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents { return @[@"AudioBirdIdScores", @"AudioBirdIdStatus", @"AudioBirdIdOpen"]; }

- (instancetype)init
{
  if ( ( self = [super init] ) ) {
    _window      = (float *)calloc( AB_HIST, sizeof( float ) );
    _bufferQueue = dispatch_queue_create( "org.inat.audiobirdid.buffer", DISPATCH_QUEUE_SERIAL );
    _inferQueue  = dispatch_queue_create( "org.inat.audiobirdid.infer", DISPATCH_QUEUE_SERIAL );
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector( audioInterrupted: )
               name:AVAudioSessionInterruptionNotification object:nil];
    [nc addObserver:self selector:@selector( mediaServicesReset )
               name:AVAudioSessionMediaServicesWereResetNotification object:nil];
  }
  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self stopEngine];
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  if ( _session ) ort->ReleaseSession( _session );
  if ( _geoSession ) ort->ReleaseSession( _geoSession );
  if ( _env ) ort->ReleaseEnv( _env );
  free( _window );
}

- (OrtSession *)openSession:(NSString *)path
{
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  if ( !_env && ort->CreateEnv( ORT_LOGGING_LEVEL_WARNING, "iNatAudio", &_env ) ) return NULL;
  OrtSessionOptions *opts;
  if ( ort->CreateSessionOptions( &opts ) ) return NULL;
  ort->SetIntraOpNumThreads( opts, 2 );
  // The arena keeps peak scratch memory for good; a smaller footprint makes
  // iOS less likely to kill the app in the background.
  ort->DisableCpuMemArena( opts );
  OrtSession *session = NULL;
  OrtStatus *status = ort->CreateSession( _env, [path UTF8String], opts, &session );
  ort->ReleaseSessionOptions( opts );
  if ( status ) { ort->ReleaseStatus( status ); return NULL; }
  return session;
}

- (BOOL)loadModel
{
  __block BOOL ok = NO;
  dispatch_sync( _inferQueue, ^{
    if ( !self->_session ) {
      NSString *path = [[NSBundle mainBundle] pathForResource:@"audio_id" ofType:@"onnx"];
      self->_session = path ? [self openSession:path] : NULL;
    }
    ok = self->_session != NULL;
  } );
  return ok;
}

// The BirdNET geomodel's occurrence score for each of its species at a place
// and week (1-48, four per month).
RCT_EXPORT_METHOD( geo:( double )lat lng:( double )lng week:( double )week
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _inferQueue, ^{
    if ( !self->_geoSession ) {
      NSString *path = [[NSBundle mainBundle] pathForResource:@"audio_geo" ofType:@"onnx"];
      self->_geoSession = path ? [self openSession:path] : NULL;
    }
    float pos[3] = { (float)lat, (float)lng, (float)week };
    NSString *error = nil;
    NSArray *out = self->_geoSession
      ? [self run:self->_geoSession input:pos length:3 inputName:"input" outputName:"probabilities"
          outputs:nil error:&error]
      : nil;
    // Used once per start; free its memory until the next.
    const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
    if ( self->_geoSession ) ort->ReleaseSession( self->_geoSession );
    self->_geoSession = NULL;
    if ( out ) resolve( out ); else reject( @"geo", error ?: @"Could not load the geomodel", nil );
  } );
}

RCT_EXPORT_METHOD( start:( NSArray<NSNumber *> * )outputs
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_sync( _inferQueue, ^{ self->_outputs = [outputs copy]; } );
  ABSpectrogramReset( );
  if ( ![self loadModel] ) {
    reject( @"model", @"Could not load the audio model", nil );
    return;
  }
  [[AVAudioSession sharedInstance] requestRecordPermission:^( BOOL granted ) {
    if ( !granted ) {
      reject( @"permission", @"Microphone permission denied", nil );
      return;
    }
    dispatch_async( dispatch_get_main_queue(), ^{
      NSError *error = nil;
      self->_wantListening = YES;
      if ( ![self startEngine:&error] ) {
        self->_wantListening = NO;
        reject( @"engine", error.localizedDescription ?: @"Could not start the microphone", error );
        return;
      }
      [self startWatchdog];
      AVAudioFormat *f = [self->_engine.inputNode outputFormatForBus:0];
      resolve( @{ @"sampleRate": @( f.sampleRate ), @"channels": @( f.channelCount ) } );
    } );
  }];
}

// Saves `seconds` (up to 16) of audio ending at sample `endFrame` (a run's
// windowFrame) as AAC at `path` (replacing any file there), for Audio ID's
// history of detections; 5 s ending at a run's windowFrame is its window.
RCT_EXPORT_METHOD( saveClip:( NSString * )path
                   seconds:( double )seconds
                   endFrame:( double )endFrame
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _bufferQueue, ^{
    NSInteger back = (NSInteger)MIN( MAX( self->_frames - (int64_t)endFrame, 0 ), AB_HIST );
    AVAudioFrameCount frames = (AVAudioFrameCount)MIN( MAX( seconds, 0 ) * AB_SR, AB_HIST - back );
    NSData *window = [NSData dataWithBytes:self->_window + AB_HIST - back - frames
                                    length:frames * sizeof( float )];
    dispatch_async( dispatch_get_global_queue( QOS_CLASS_UTILITY, 0 ), ^{
      NSFileManager *fm = [NSFileManager defaultManager];
      [fm createDirectoryAtPath:[path stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES attributes:nil error:nil];
      [fm removeItemAtPath:path error:nil];
      NSError *error = nil;
      AVAudioFile *file = [[AVAudioFile alloc]
        initForWriting:[NSURL fileURLWithPath:path]
              settings:@{ AVFormatIDKey: @( kAudioFormatMPEG4AAC ), AVSampleRateKey: @( AB_SR ),
                          AVNumberOfChannelsKey: @1, AVEncoderBitRateKey: @64000 }
          commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
      AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat
                                                              frameCapacity:frames];
      buffer.frameLength = frames;
      if ( buffer ) memcpy( buffer.floatChannelData[0], window.bytes, window.length );
      BOOL ok = file && buffer && [file writeFromBuffer:buffer error:&error];
      file = nil; // closes the file
      if ( ok ) resolve( path ); else reject( @"clip", error.localizedDescription ?: @"Could not save the clip", error );
    } );
  } );
}

RCT_EXPORT_METHOD( stop )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    self->_wantListening = NO;
    if ( self->_watchdog ) dispatch_source_cancel( self->_watchdog );
    self->_watchdog = nil;
    [self stopEngine];
  } );
}

// Vibrates for a detection with the system vibration, which plays in the
// background and with the screen off while the recording session keeps the
// app running, and ignores the silent switch and Do Not Disturb.
RCT_EXPORT_METHOD( vibrate:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    AVAudioSession *session = [AVAudioSession sharedInstance];
    [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
    AudioServicesPlayAlertSound( kSystemSoundID_Vibrate );
    resolve( @{
      @"allowed": @( session.allowHapticsAndSystemSoundsDuringRecording ),
      @"error": [NSNull null],
    } );
  } );
}

// Measurement mode plays back far quieter through the speaker, so clips play
// in the default mode while listening; detections pause during playback anyway.
RCT_EXPORT_METHOD( setPlayingClip:( BOOL )playing )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    self->_playingClip = playing;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    if ( [session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord] ) {
      [session setMode:playing ? AVAudioSessionModeDefault : AVAudioSessionModeMeasurement
                 error:nil];
    }
  } );
}

// Vibrates with Core Haptics, for comparing against the system vibration.
// iOS stops Core Haptics once the app leaves the foreground.
RCT_EXPORT_METHOD( vibrateHaptics:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    AVAudioSession *session = [AVAudioSession sharedInstance];
    NSError *error = nil;
    [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
    if ( !self->_haptics ) {
      self->_haptics = [[CHHapticEngine alloc] initWithAudioSession:session error:&error];
      self->_haptics.playsHapticsOnly = YES;
      self->_haptics.autoShutdownEnabled = YES;
      self->_haptics.resetHandler = ^{ self->_haptics = nil; };
    }
    CHHapticEvent *buzz = [[CHHapticEvent alloc]
      initWithEventType:CHHapticEventTypeHapticContinuous
             parameters:@[
               [[CHHapticEventParameter alloc]
                 initWithParameterID:CHHapticEventParameterIDHapticIntensity value:1]
             ]
           relativeTime:0
               duration:0.4];
    CHHapticPattern *pattern = [[CHHapticPattern alloc]
      initWithEvents:@[buzz] parameters:@[] error:&error];
    id<CHHapticPatternPlayer> player = pattern
      ? [self->_haptics createPlayerWithPattern:pattern error:&error]
      : nil;
    if ( player && [self->_haptics startAndReturnError:&error] ) {
      [player startAtTime:CHHapticTimeImmediate error:&error];
    }
    resolve( @{
      @"allowed": @( session.allowHapticsAndSystemSoundsDuringRecording ),
      @"error": error ? error.localizedDescription : [NSNull null],
    } );
  } );
}

// Posts a local notification for a detection, shown as a banner even with the
// app in the foreground. Asks for permission on first use.
RCT_EXPORT_METHOD( notify:( NSString * )title body:( NSString * )body )
{
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  if ( !center.delegate ) center.delegate = self;
  [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound
                        completionHandler:^( BOOL granted, NSError *error ) {
    if ( !granted ) return;
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = title;
    content.body = body;
    [center addNotificationRequest:[UNNotificationRequest
      requestWithIdentifier:[NSUUID UUID].UUIDString content:content trigger:nil]
             withCompletionHandler:nil];
  }];
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void ( ^ )( UNNotificationPresentationOptions ))completionHandler
{
  completionHandler( UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList );
}

// Tapping a detection notification opens Audio ID.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void ( ^ )( void ))completionHandler
{
  [self sendEventWithName:@"AudioBirdIdOpen" body:nil];
  completionHandler( );
}

- (void)status:(NSString *)message
{
  [self sendEventWithName:@"AudioBirdIdStatus" body:message];
}

// Other audio in the app, or another app taking the microphone while this one
// is in the background, can stop audio without a notification reaching us,
// sometimes with the engine still reporting itself running. So check every
// few seconds that audio is still arriving.
- (void)startWatchdog
{
  if ( _watchdog ) return;
  _watchdog = dispatch_source_create( DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue() );
  dispatch_source_set_timer( _watchdog, dispatch_time( DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC ),
                             3 * NSEC_PER_SEC, NSEC_PER_SEC );
  __weak AudioBirdId *weakSelf = self;
  dispatch_source_set_event_handler( _watchdog, ^{
    AudioBirdId *me = weakSelf;
    if ( !me || !me->_wantListening ) return;
    double silentFor = CFAbsoluteTimeGetCurrent( ) - me->_lastAudio;
    if ( !me->_engine.isRunning || silentFor > 5 ) {
      [me restart:[NSString stringWithFormat:@"no audio for %.0f s, engine %@", silentFor,
                   me->_engine.isRunning ? @"running" : @"stopped"]];
    }
  } );
  dispatch_resume( _watchdog );
}

// A phone call, Siri, or another app's recording stops the engine; pick
// listening back up when the interruption ends.
- (void)audioInterrupted:(NSNotification *)note
{
  NSUInteger type = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( type == AVAudioSessionInterruptionTypeBegan ) {
      [self status:[NSString stringWithFormat:@"interrupted, reason %@",
                    note.userInfo[AVAudioSessionInterruptionReasonKey] ?: @"none"]];
      [self teardownEngine];
    } else {
      [self restart:@"interruption ended"];
    }
  } );
}

- (void)mediaServicesReset
{
  [self restart:@"media services reset"];
}

// Starting the microphone can fail while the app is in the background; the
// watchdog keeps retrying, so only the first failure in a row is reported.
- (void)restart:(NSString *)reason
{
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( !self->_wantListening ) return;
    [self teardownEngine];
    NSError *error = nil;
    BOOL ok = [self startEngine:&error];
    NSInteger failures = self->_restartFailures;
    self->_restartFailures = ok ? 0 : failures + 1;
    if ( ok || failures == 0 ) {
      BOOL background = [UIApplication sharedApplication].applicationState
        == UIApplicationStateBackground;
      [self status:[NSString stringWithFormat:@"restart after %@ in %@: %@", reason,
                    background ? @"background" : @"foreground",
                    ok ? [NSString stringWithFormat:@"ok after %ld failures", (long)failures]
                       : error.localizedDescription ?: @"failed"]];
    }
  } );
}

// Also restarts when the engine's configuration changes (e.g. a headset
// microphone is plugged in or removed), which stops it.
- (void)engineConfigurationChanged:(NSNotification *)note
{
  [self restart:@"configuration change"];
}

- (BOOL)startEngine:(NSError **)error
{
  if ( _engine.isRunning ) return YES;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  // Measurement mode turns off voice processing and gain control, which
  // would otherwise suppress exactly the quiet, tonal sounds we want.
  if ( ![session setCategory:AVAudioSessionCategoryPlayAndRecord
                        mode:_playingClip ? AVAudioSessionModeDefault
                                          : AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionMixWithOthers
                           | AVAudioSessionCategoryOptionDefaultToSpeaker
                       error:error] ) return NO;
  // iOS silences vibration while recording unless we opt in.
  [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
  if ( ![session setActive:YES error:error] ) return NO;

  _engine = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = _engine.inputNode;
  AVAudioFormat *inFormat = [input outputFormatForBus:0];
  _outFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                                sampleRate:AB_SR
                                                  channels:1
                                               interleaved:NO];
  _converter = [[AVAudioConverter alloc] initFromFormat:inFormat toFormat:_outFormat];
  dispatch_sync( _bufferQueue, ^{
    // Start with silence so the first run happens right away, before 5 s of
    // audio have arrived.
    memset( self->_window, 0, AB_HIST * sizeof( float ) );
    self->_sinceRun = AB_STEP;
    self->_specPending = 0;
  } );
  _lastAudio = CFAbsoluteTimeGetCurrent( );

  [[NSNotificationCenter defaultCenter] addObserver:self
                                           selector:@selector( engineConfigurationChanged: )
                                               name:AVAudioEngineConfigurationChangeNotification
                                             object:_engine];
  __weak AudioBirdId *weakSelf = self;
  [input installTapOnBus:0 bufferSize:4096 format:inFormat
                   block:^( AVAudioPCMBuffer *buffer, AVAudioTime *when ) {
    [weakSelf handleBuffer:buffer inRate:inFormat.sampleRate];
  }];
  [_engine prepare];
  if ( ![_engine startAndReturnError:error] ) {
    [input removeTapOnBus:0];
    _engine = nil;
    return NO;
  }
  return YES;
}

- (void)teardownEngine
{
  if ( !_engine ) return;
  [[NSNotificationCenter defaultCenter] removeObserver:self
                                                  name:AVAudioEngineConfigurationChangeNotification
                                                object:_engine];
  [_engine.inputNode removeTapOnBus:0];
  [_engine stop];
  _engine = nil;
}

- (void)stopEngine
{
  if ( !_engine ) return;
  [self teardownEngine];
  [[AVAudioSession sharedInstance] setActive:NO
                                 withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                       error:nil];
}

- (void)handleBuffer:(AVAudioPCMBuffer *)buffer inRate:(double)inRate
{
  AVAudioFrameCount cap = (AVAudioFrameCount)ceil( buffer.frameLength * AB_SR / inRate ) + 32;
  AVAudioPCMBuffer *out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_outFormat frameCapacity:cap];
  __block BOOL fed = NO;
  NSError *error = nil;
  [_converter convertToBuffer:out error:&error
           withInputFromBlock:^AVAudioBuffer *( AVAudioPacketCount n,
                                                AVAudioConverterInputStatus *status ) {
    if ( fed ) { *status = AVAudioConverterInputStatus_NoDataNow; return nil; }
    fed = YES;
    *status = AVAudioConverterInputStatus_HaveData;
    return buffer;
  }];
  NSInteger n = out.frameLength;
  if ( error || n == 0 ) return;
  _lastAudio = CFAbsoluteTimeGetCurrent( );
  NSData *samples = [NSData dataWithBytes:out.floatChannelData[0] length:n * sizeof( float )];

  dispatch_async( _bufferQueue, ^{
    const float *s = (const float *)samples.bytes;
    NSInteger count = MIN( n, (NSInteger)AB_HIST );
    s += n - count;
    memmove( self->_window, self->_window + count, ( AB_HIST - count ) * sizeof( float ) );
    memcpy( self->_window + AB_HIST - count, s, count * sizeof( float ) );
    self->_sinceRun += count;
    self->_frames += n;
    self->_specPending += count;
    while ( self->_specPending >= AB_SPEC_HOP ) {
      self->_specPending -= AB_SPEC_HOP;
      ABSpectrogramPush( self->_window + AB_HIST - self->_specPending - AB_SPEC_N );
    }

    float sumSq = 0;
    for ( NSInteger i = 0; i < count; i++ ) sumSq += s[i] * s[i];
    self->_level = sqrtf( sumSq / MAX( count, 1 ) );

    // Drop a step rather than queue up if the previous inference is still
    // running.
    if ( self->_sinceRun < AB_STEP || self->_busy ) return;
    self->_sinceRun = 0;
    self->_busy = YES;
    NSData *window = [NSData dataWithBytes:self->_window + AB_HIST - AB_WIN
                                    length:AB_WIN * sizeof( float )];
    float level = self->_level;
    int64_t windowFrame = self->_frames;
    // When the window's last sample arrived, on the clock JS's Date.now uses.
    double windowEnd = [[NSDate date] timeIntervalSince1970] * 1000;
    dispatch_async( self->_inferQueue, ^{
      NSString *inferError = nil;
      CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent( );
      NSArray *scores = [self run:self->_session input:(const float *)window.bytes length:AB_WIN
                        inputName:"input" outputName:"output" outputs:self->_outputs
                            error:&inferError];
      double ms = ( CFAbsoluteTimeGetCurrent( ) - t0 ) * 1000;
      dispatch_async( self->_bufferQueue, ^{ self->_busy = NO; } );
      [self sendEventWithName:@"AudioBirdIdScores"
                         body:@{ @"scores": scores ?: @[],
                                 @"level": @( level ),
                                 @"windowEnd": @( windowEnd ),
                                 @"windowFrame": @( windowFrame ),
                                 @"inferMs": @( ms ),
                                 @"memMB": @( [self footprintMB] ),
                                 @"error": inferError ?: [NSNull null] }];
    } );
  } );
}

// What iOS counts against the app when deciding what to kill.
- (double)footprintMB
{
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if ( task_info( mach_task_self( ), TASK_VM_INFO, (task_info_t)&info, &count ) != KERN_SUCCESS ) {
    return 0;
  }
  return info.phys_footprint / 1048576.0;
}

// One run of a [1, length] -> [1, n] model; returns the outputs listed in
// `outputs`, in that order, or all of them when it is nil.
- (NSArray<NSNumber *> *)run:(OrtSession *)session input:(const float *)samples
                      length:(int64_t)length inputName:(const char *)inputName
                  outputName:(const char *)outputName outputs:(NSArray<NSNumber *> *)outputs
                       error:(NSString **)errorMessage
{
  if ( !session ) return nil;
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  OrtMemoryInfo *memInfo;
  ort->CreateCpuMemoryInfo( OrtArenaAllocator, OrtMemTypeDefault, &memInfo );
  int64_t shape[] = { 1, length };
  OrtValue *input = NULL;
  OrtStatus *status = ort->CreateTensorWithDataAsOrtValue(
    memInfo, (void *)samples, length * sizeof( float ), shape, 2,
    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input );
  ort->ReleaseMemoryInfo( memInfo );
  if ( status ) {
    *errorMessage = @( ort->GetErrorMessage( status ) );
    ort->ReleaseStatus( status );
    return nil;
  }

  const char *inputNames[]  = { inputName };
  const char *outputNames[] = { outputName };
  OrtValue *output = NULL;
  status = ort->Run( session, NULL, inputNames, (const OrtValue *const *)&input, 1,
                     outputNames, 1, &output );
  ort->ReleaseValue( input );
  if ( status || !output ) {
    if ( status ) {
      *errorMessage = @( ort->GetErrorMessage( status ) );
      ort->ReleaseStatus( status );
    }
    return nil;
  }

  OrtTensorTypeAndShapeInfo *info;
  ort->GetTensorTypeAndShape( output, &info );
  size_t count = 0;
  ort->GetTensorShapeElementCount( info, &count );
  ort->ReleaseTensorTypeAndShapeInfo( info );
  float *probs;
  ort->GetTensorMutableData( output, (void **)&probs );
  NSMutableArray *scores = [NSMutableArray arrayWithCapacity:outputs ? outputs.count : count];
  if ( outputs ) {
    for ( NSNumber *i in outputs ) {
      size_t k = i.unsignedIntegerValue;
      [scores addObject:@( k < count ? probs[k] : 0 )];
    }
  } else {
    for ( size_t i = 0; i < count; i++ ) [scores addObject:@( probs[i] )];
  }
  ort->ReleaseValue( output );
  return scores;
}

@end

// Draws the live spectrogram: the last 10 s, dark marks on white, low
// frequencies at the bottom, redrawn each frame that new columns arrive.
@interface AudioSpectrogramView : UIView
@end

@implementation AudioSpectrogramView {
  CADisplayLink *_link;
  NSInteger      _drawnCount;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  [_link invalidate];
  _link = nil;
  if ( !self.window ) return;
  self.layer.magnificationFilter = kCAFilterLinear;
  _drawnCount = -1;
  _link = [CADisplayLink displayLinkWithTarget:self selector:@selector( tick )];
  _link.preferredFrameRateRange = CAFrameRateRangeMake( 30, 60, 60 );
  [_link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)tick
{
  static uint32_t pixels[AB_SPEC_H * AB_SPEC_W];
  os_unfair_lock_lock( &abSpecLock );
  if ( abSpecCount == _drawnCount ) {
    os_unfair_lock_unlock( &abSpecLock );
    return;
  }
  _drawnCount = abSpecCount;
  for ( NSInteger x = 0; x < AB_SPEC_W; x++ ) {
    // Oldest column on the left; columns not yet heard stay blank.
    NSInteger c = abSpecCount - AB_SPEC_W + x;
    const uint8_t *levels = c >= 0 ? abSpecLevel[c % AB_SPEC_W] : NULL;
    for ( int y = 0; y < AB_SPEC_H; y++ ) {
      uint32_t g = 255 - ( levels ? levels[y] : 0 );
      // Little-endian RGBX, top row first.
      pixels[( AB_SPEC_H - 1 - y ) * AB_SPEC_W + x] = g | g << 8 | g << 16 | 0xff000000u;
    }
  }
  os_unfair_lock_unlock( &abSpecLock );
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB( );
  CGContextRef ctx = CGBitmapContextCreate( pixels, AB_SPEC_W, AB_SPEC_H, 8, AB_SPEC_W * 4, space,
                                            kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big );
  CGImageRef image = CGBitmapContextCreateImage( ctx );
  self.layer.contents = (__bridge id)image;
  CGImageRelease( image );
  CGContextRelease( ctx );
  CGColorSpaceRelease( space );
}

@end

@interface AudioSpectrogramManager : RCTViewManager
@end

@implementation AudioSpectrogramManager

RCT_EXPORT_MODULE( )

- (UIView *)view { return [AudioSpectrogramView new]; }

@end
