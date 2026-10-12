#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreHaptics/CoreHaptics.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
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

#define AB_SR       32000
#define AB_WIN      160000  // 5 s, BirdNET v3.0's input
#define AB_STEP     32000   // run every 1 s of new audio
#define AB_SPEC_HOP 4000    // spectrogram columns, 8 per second
#define AB_SPEC_N   1024    // samples per spectrogram column
#define AB_SPEC_BINS 32     // log-spaced bins from 500 Hz to 12 kHz

@interface AudioBirdId : RCTEventEmitter <RCTBridgeModule, UNUserNotificationCenterDelegate>
@end

@implementation AudioBirdId {
  AVAudioEngine    *_engine;
  AVAudioConverter *_converter;
  AVAudioFormat    *_outFormat;
  float            *_window;
  NSInteger         _filled;
  NSInteger         _sinceRun;
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
}

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents { return @[@"AudioBirdIdScores"]; }

- (instancetype)init
{
  if ( ( self = [super init] ) ) {
    _window      = (float *)calloc( AB_WIN, sizeof( float ) );
    _bufferQueue = dispatch_queue_create( "org.inat.audiobirdid.buffer", DISPATCH_QUEUE_SERIAL );
    _inferQueue  = dispatch_queue_create( "org.inat.audiobirdid.infer", DISPATCH_QUEUE_SERIAL );
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector( audioInterrupted: )
               name:AVAudioSessionInterruptionNotification object:nil];
    [nc addObserver:self selector:@selector( restartIfWanted )
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
    if ( out ) resolve( out ); else reject( @"geo", error ?: @"Could not load the geomodel", nil );
  } );
}

RCT_EXPORT_METHOD( start:( NSArray<NSNumber *> * )outputs
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_sync( _inferQueue, ^{ self->_outputs = [outputs copy]; } );
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

RCT_EXPORT_METHOD( stop )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    self->_wantListening = NO;
    if ( self->_watchdog ) dispatch_source_cancel( self->_watchdog );
    self->_watchdog = nil;
    [self stopEngine];
  } );
}

// Vibrates for a detection. Core Haptics plays regardless of the silent
// switch and Do Not Disturb, and keeps playing in the background alongside
// the recording audio session; the system vibration is a fallback for when
// the engine can't run.
RCT_EXPORT_METHOD( vibrate:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    AVAudioSession *session = [AVAudioSession sharedInstance];
    NSError *error = nil;
    [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
    if ( !self->_haptics ) {
      self->_haptics = [[CHHapticEngine alloc] initWithAudioSession:session error:&error];
      self->_haptics.playsHapticsOnly = YES;
      self->_haptics.isAutoShutdownEnabled = YES;
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
    if ( !player
        || ![self->_haptics startAndReturnError:&error]
        || ![player startAtTime:CHHapticTimeImmediate error:&error] ) {
      AudioServicesPlayAlertSound( kSystemSoundID_Vibrate );
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

// Other audio in the app can reconfigure or deactivate the shared audio
// session without a notification reaching us; check every few seconds.
- (void)startWatchdog
{
  if ( _watchdog ) return;
  _watchdog = dispatch_source_create( DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue() );
  dispatch_source_set_timer( _watchdog, dispatch_time( DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC ),
                             3 * NSEC_PER_SEC, NSEC_PER_SEC );
  __weak AudioBirdId *weakSelf = self;
  dispatch_source_set_event_handler( _watchdog, ^{
    AudioBirdId *me = weakSelf;
    if ( me && me->_wantListening && !me->_engine.isRunning ) [me restartIfWanted];
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
      [self teardownEngine];
    } else {
      [self restartIfWanted];
    }
  } );
}

- (void)restartIfWanted
{
  dispatch_async( dispatch_get_main_queue(), ^{
    if ( !self->_wantListening ) return;
    [self teardownEngine];
    [self startEngine:nil];
  } );
}

// Also restarts when the engine's configuration changes (e.g. a headset
// microphone is plugged in or removed), which stops it.
- (void)engineConfigurationChanged:(NSNotification *)note
{
  [self restartIfWanted];
}

- (BOOL)startEngine:(NSError **)error
{
  if ( _engine.isRunning ) return YES;
  AVAudioSession *session = [AVAudioSession sharedInstance];
  // Measurement mode turns off voice processing and gain control, which
  // would otherwise suppress exactly the quiet, tonal sounds we want.
  if ( ![session setCategory:AVAudioSessionCategoryPlayAndRecord
                        mode:AVAudioSessionModeMeasurement
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
  dispatch_sync( _bufferQueue, ^{ self->_filled = 0; self->_sinceRun = 0; } );

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
  NSData *samples = [NSData dataWithBytes:out.floatChannelData[0] length:n * sizeof( float )];

  dispatch_async( _bufferQueue, ^{
    const float *s = (const float *)samples.bytes;
    NSInteger count = MIN( n, (NSInteger)AB_WIN );
    s += n - count;
    memmove( self->_window, self->_window + count, ( AB_WIN - count ) * sizeof( float ) );
    memcpy( self->_window + AB_WIN - count, s, count * sizeof( float ) );
    self->_filled = MIN( self->_filled + count, (NSInteger)AB_WIN );
    self->_sinceRun += count;

    float sumSq = 0;
    for ( NSInteger i = 0; i < count; i++ ) sumSq += s[i] * s[i];
    self->_level = sqrtf( sumSq / MAX( count, 1 ) );

    // Wait for a full window, and drop a step rather than queue up if the
    // previous inference is still running.
    if ( self->_filled < AB_WIN || self->_sinceRun < AB_STEP || self->_busy ) return;
    NSArray *spectrogram = [self spectrogramOfLast:MIN( self->_sinceRun, (NSInteger)AB_WIN )];
    self->_sinceRun = 0;
    self->_busy = YES;
    NSData *window = [NSData dataWithBytes:self->_window length:AB_WIN * sizeof( float )];
    float level = self->_level;
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
                                 @"inferMs": @( ms ),
                                 @"spectrogram": spectrogram,
                                 @"error": inferError ?: [NSNull null] }];
    } );
  } );
}

// Spectrogram columns for the newest `samples` of the window, oldest first:
// each is AB_SPEC_BINS Goertzel magnitudes of a Hann-windowed frame, mapped
// from -100..-20 dB to 0..1.
- (NSArray<NSArray<NSNumber *> *> *)spectrogramOfLast:(NSInteger)samples
{
  static float hann[AB_SPEC_N];
  static float coeff[AB_SPEC_BINS];
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    for ( int i = 0; i < AB_SPEC_N; i++ ) {
      hann[i] = 0.5f - 0.5f * cosf( 2 * M_PI * i / ( AB_SPEC_N - 1 ) );
    }
    for ( int b = 0; b < AB_SPEC_BINS; b++ ) {
      double hz = 500 * pow( 12000.0 / 500, (double)b / ( AB_SPEC_BINS - 1 ) );
      coeff[b] = (float)( 2 * cos( 2 * M_PI * hz / AB_SR ) );
    }
  } );
  NSInteger cols = samples / AB_SPEC_HOP;
  NSMutableArray *out = [NSMutableArray arrayWithCapacity:cols];
  for ( NSInteger c = cols; c > 0; c-- ) {
    const float *frame = _window + AB_WIN - c * AB_SPEC_HOP;
    NSMutableArray *col = [NSMutableArray arrayWithCapacity:AB_SPEC_BINS];
    for ( int b = 0; b < AB_SPEC_BINS; b++ ) {
      float s1 = 0, s2 = 0;
      for ( int i = 0; i < AB_SPEC_N; i++ ) {
        float s0 = frame[i] * hann[i] + coeff[b] * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      float power = ( s1 * s1 + s2 * s2 - coeff[b] * s1 * s2 ) / ( AB_SPEC_N * AB_SPEC_N / 4.0f );
      float db = 10 * log10f( power + 1e-12f );
      [col addObject:@( MAX( 0.0f, MIN( 1.0f, ( db + 100 ) / 80 ) ) )];
    }
    [out addObject:col];
  }
  return out;
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
