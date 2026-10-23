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
// build_model.py). Scores go out only for the outputs JS asks for, and of
// those only the top one and any at or above JS's minimum score. Everything
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
#define AB_FRAME_RUNS 16 // runs' frame logits kept, covering a 15 s context clip
#define AB_SPEC_HOP 400     // spectrogram columns, 80 per second
#define AB_SPEC_LOG2N 10
#define AB_SPEC_N   ( 1 << AB_SPEC_LOG2N ) // samples per FFT, 31.25 Hz bins
#define AB_SPEC_LO  8       // lowest bin shown, 250 Hz
#define AB_SPEC_H   376     // bins shown, up to 12 kHz
#define AB_SPEC_W   800     // columns shown, 10 s

// Writes mono samples as AAC at `path`, replacing any file there.
static BOOL ABWriteClip( NSString *path, const float *samples, AVAudioFrameCount frames,
                         NSError **error )
{
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm createDirectoryAtPath:[path stringByDeletingLastPathComponent]
withIntermediateDirectories:YES attributes:nil error:nil];
  [fm removeItemAtPath:path error:nil];
  AVAudioFile *file = [[AVAudioFile alloc]
    initForWriting:[NSURL fileURLWithPath:path]
          settings:@{ AVFormatIDKey: @( kAudioFormatMPEG4AAC ), AVSampleRateKey: @( AB_SR ),
                      AVNumberOfChannelsKey: @1, AVEncoderBitRateKey: @64000 }
      commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:error];
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat
                                                          frameCapacity:frames];
  buffer.frameLength = frames;
  if ( buffer ) memcpy( buffer.floatChannelData[0], samples, frames * sizeof( float ) );
  return file && buffer && [file writeFromBuffer:buffer error:error];
}

// The live spectrogram, shared between the module, which adds a column for
// every AB_SPEC_HOP new samples, and AudioSpectrogram views, which draw it.
// Intensities are kept in a ring of columns.
static os_unfair_lock abSpecLock = OS_UNFAIR_LOCK_INIT;
static uint8_t  abSpecLevel[AB_SPEC_W][AB_SPEC_H]; // 0..255, low frequencies first
static NSInteger abSpecCount;                      // columns added so far
// Live spectrogram views on screen, logged with the memory footprint.
static _Atomic int abSpecViews;

static void ABSpectrogramReset( void )
{
  os_unfair_lock_lock( &abSpecLock );
  memset( abSpecLevel, 0, sizeof( abSpecLevel ) );
  abSpecCount = 0;
  os_unfair_lock_unlock( &abSpecLock );
}

// One column from the AB_SPEC_N samples at `frame`: power of a Hann-windowed
// FFT, mapped from -100..-20 dB to 0..1, with faint noise dropped and contrast
// boosted as in Merlin. Safe to call from any thread.
static void ABSpectrogramColumn( const float *frame, uint8_t *col )
{
  static FFTSetup fft;
  static float hann[AB_SPEC_N];
  static dispatch_once_t once;
  dispatch_once( &once, ^{
    fft = vDSP_create_fftsetup( AB_SPEC_LOG2N, kFFTRadix2 );
    vDSP_hann_window( hann, AB_SPEC_N, vDSP_HANN_DENORM );
  } );
  float re[AB_SPEC_N / 2], im[AB_SPEC_N / 2], power[AB_SPEC_N / 2];
  float windowed[AB_SPEC_N];
  vDSP_vmul( frame, 1, hann, 1, windowed, 1, AB_SPEC_N );
  DSPSplitComplex split = { re, im };
  vDSP_ctoz( (const DSPComplex *)windowed, 2, &split, 1, AB_SPEC_N / 2 );
  vDSP_fft_zrip( fft, &split, 1, AB_SPEC_LOG2N, FFT_FORWARD );
  vDSP_zvmags( &split, 1, power, 1, AB_SPEC_N / 2 );
  for ( int b = 0; b < AB_SPEC_H; b++ ) {
    // zrip doubles the DFT, so this matches a sine's amplitude^2 / 4.
    float db = 10 * log10f( power[AB_SPEC_LO + b] / ( AB_SPEC_N * AB_SPEC_N ) + 1e-12f );
    float v = ( db + 100 ) / 80;
    col[b] = v > 0.1f ? (uint8_t)( 255 * powf( MIN( 1, ( v - 0.1f ) / 0.9f ), 1.5f ) ) : 0;
  }
}

static void ABSpectrogramPush( const float *frame )
{
  uint8_t col[AB_SPEC_H];
  ABSpectrogramColumn( frame, col );
  os_unfair_lock_lock( &abSpecLock );
  NSInteger x = abSpecCount % AB_SPEC_W;
  memcpy( abSpecLevel[x], col, AB_SPEC_H );
  abSpecCount++;
  os_unfair_lock_unlock( &abSpecLock );
}

// Grayscale image of `width` columns of levels, low frequencies at the bottom.
static CGImageRef ABSpectrogramImage( const uint8_t *levels, NSInteger width )
{
  uint8_t *pixels = malloc( AB_SPEC_H * width );
  for ( NSInteger x = 0; x < width; x++ ) {
    for ( int y = 0; y < AB_SPEC_H; y++ ) {
      // Top row first.
      pixels[( AB_SPEC_H - 1 - y ) * width + x] =
        255 - ( levels ? levels[x * AB_SPEC_H + y] : 0 );
    }
  }
  CGColorSpaceRef space = CGColorSpaceCreateDeviceGray( );
  CGContextRef ctx = CGBitmapContextCreate( pixels, width, AB_SPEC_H, 8, width, space,
                                            kCGImageAlphaNone );
  CGImageRef image = CGBitmapContextCreateImage( ctx );
  CGContextRelease( ctx );
  CGColorSpaceRelease( space );
  free( pixels );
  return image;
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
  // The last AB_FRAME_RUNS runs' per-frame logits, for finding a call's span:
  // @[windowFrame, float data (outputs x frames), frames per output]
  NSMutableArray<NSArray *> *_frameRuns;
  float             _minScore;
  OrtSession       *_geoSession;
  BOOL              _wantListening;
  dispatch_source_t _watchdog;
  CHHapticEngine   *_haptics;
  CFAbsoluteTime    _lastAudio;
  NSInteger         _restartFailures;
  BOOL              _playingClip;
  CFAbsoluteTime    _muteUntil; // mic audio is zeroed until then, and while a clip plays
  AVAudioEngine    *_clipEngine;
  AVAudioPlayerNode *_clipNode;
  RCTPromiseResolveBlock _clipDone;
}

RCT_EXPORT_MODULE( );

+ (BOOL)requiresMainQueueSetup { return NO; }

- (NSArray<NSString *> *)supportedEvents { return @[@"AudioBirdIdScores", @"AudioBirdIdStatus", @"AudioBirdIdOpen"]; }

- (instancetype)init
{
  if ( ( self = [super init] ) ) {
    _window      = (float *)calloc( AB_HIST, sizeof( float ) );
    // Both queues stay busy while listening, so their threads never idle long
    // enough to drain an autorelease pool; drain one per block instead.
    dispatch_queue_attr_t serial = dispatch_queue_attr_make_with_autorelease_frequency(
      DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM );
    _bufferQueue = dispatch_queue_create( "org.inat.audiobirdid.buffer", serial );
    _inferQueue  = dispatch_queue_create( "org.inat.audiobirdid.infer", serial );
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
    NSData *probs = self->_geoSession
      ? [self run:self->_geoSession input:pos length:3 inputName:"input" outputName:"probabilities"
          outputs:nil error:&error]
      : nil;
    NSMutableArray *out = probs ? [NSMutableArray array] : nil;
    const float *p = (const float *)probs.bytes;
    for ( NSUInteger i = 0; i < probs.length / sizeof( float ); i++ ) [out addObject:@( p[i] )];
    // Used once per start; free its memory until the next.
    const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
    if ( self->_geoSession ) ort->ReleaseSession( self->_geoSession );
    self->_geoSession = NULL;
    if ( out ) resolve( out ); else reject( @"geo", error ?: @"Could not load the geomodel", nil );
  } );
}

RCT_EXPORT_METHOD( start:( NSArray<NSNumber *> * )outputs
                   minScore:( double )minScore
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_sync( _inferQueue, ^{
    self->_outputs = [outputs copy];
    self->_frameRuns = [NSMutableArray array];
    self->_minScore = (float)minScore;
  } );
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
      NSError *error = nil;
      if ( ABWriteClip( path, (const float *)window.bytes, frames, &error ) ) resolve( path );
      else reject( @"clip", error.localizedDescription ?: @"Could not save the clip", error );
    } );
  } );
}

// The mean per-frame logit of output `index` (its position in start's
// outputs) in each 1/3 s of the `seconds` before sample `endFrame`, over the
// recent runs whose windows cover it, or null where none do. The model scores
// 15 frames per 5 s window, so a call shows as a few bins above 0.
RCT_EXPORT_METHOD( timeline:( double )index
                   endFrame:( double )endFrame
                   seconds:( double )seconds
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( _inferQueue, ^{
    NSInteger bins = MAX( (NSInteger)lround( seconds * 3 ), 1 );
    double binLen = AB_SR / 3.0, start = endFrame - bins * binLen;
    double *sum = (double *)calloc( bins, sizeof( double ) );
    int *count = (int *)calloc( bins, sizeof( int ) );
    for ( NSArray *r in self->_frameRuns ) {
      double end = [r[0] doubleValue];
      NSData *data = r[1];
      NSInteger t = [r[2] integerValue];
      if ( t <= 0 || ( (NSInteger)index + 1 ) * t * (NSInteger)sizeof( float ) > (NSInteger)data.length ) {
        continue;
      }
      const float *f = (const float *)data.bytes + (NSInteger)index * t;
      for ( NSInteger i = 0; i < t; i++ ) {
        double center = end - AB_WIN + ( i + 0.5 ) * AB_WIN / t;
        NSInteger b = (NSInteger)floor( ( center - start ) / binLen );
        if ( b < 0 || b >= bins ) continue;
        sum[b] += f[i];
        count[b]++;
      }
    }
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:bins];
    for ( NSInteger b = 0; b < bins; b++ ) {
      [out addObject:count[b] ? @( sum[b] / count[b] ) : [NSNull null]];
    }
    free( sum );
    free( count );
    resolve( out );
  } );
}

// Saves `from` to `to` seconds of the clip at `path` as a new clip at `outPath`.
RCT_EXPORT_METHOD( trimClip:( NSString * )path
                   from:( double )from
                   to:( double )to
                   outPath:( NSString * )outPath
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_UTILITY, 0 ), ^{
    NSError *error = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path]
                                                      error:&error];
    AVAudioPCMBuffer *buffer = file
      ? [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat
                                      frameCapacity:(AVAudioFrameCount)file.length]
      : nil;
    if ( !buffer || ![file readIntoBuffer:buffer error:&error] ) {
      reject( @"clip", error.localizedDescription ?: @"Could not read the clip", error );
      return;
    }
    AVAudioFramePosition f0 = MIN( (AVAudioFramePosition)MAX( from * AB_SR, 0 ), buffer.frameLength );
    AVAudioFramePosition f1 = MAX( MIN( (AVAudioFramePosition)( to * AB_SR ), buffer.frameLength ), f0 );
    if ( f1 > f0 && ABWriteClip( outPath, buffer.floatChannelData[0] + f0,
                                 (AVAudioFrameCount)( f1 - f0 ), &error ) ) {
      resolve( outPath );
    } else {
      reject( @"clip", error.localizedDescription ?: @"Could not trim the clip", error );
    }
  } );
}

// Plays a clip, resolving when it ends or is stopped. Measurement mode records
// without gain control, so clips are quiet; this raises them in memory, leaving
// the file untouched, to a loud RMS level (at most 30 dB of gain) and soft-limits
// the peaks that this pushes past full scale.
RCT_EXPORT_METHOD( playClip:( NSString * )path
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  [self playClip:path from:0 to:-1 resolve:resolve reject:reject];
}

// Plays the clip from `from` to `to` seconds in; a negative `to` plays to the end.
RCT_EXPORT_METHOD( playClipRange:( NSString * )path
                   from:( double )from
                   to:( double )to
                   resolver:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
  [self playClip:path from:from to:to resolve:resolve reject:reject];
}

- (void)playClip:(NSString *)path from:(double)from to:(double)to
         resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async( dispatch_get_main_queue(), ^{
    [self stopClipPlayback];
    NSError *error = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path]
                                                      error:&error];
    AVAudioPCMBuffer *buffer = file
      ? [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat
                                      frameCapacity:(AVAudioFrameCount)file.length]
      : nil;
    if ( !buffer || ![file readIntoBuffer:buffer error:&error] ) {
      reject( @"clip", error.localizedDescription ?: @"Could not read the clip", error );
      return;
    }
    AVAudioChannelCount channels = buffer.format.channelCount;
    float peak = 0, rms = 0;
    for ( AVAudioChannelCount c = 0; c < channels; c++ ) {
      float p = 0, r = 0;
      vDSP_maxmgv( buffer.floatChannelData[c], 1, &p, buffer.frameLength );
      vDSP_rmsqv( buffer.floatChannelData[c], 1, &r, buffer.frameLength );
      peak = MAX( peak, p );
      rms = MAX( rms, r );
    }
    // 0.95 * tanh( x / 0.95 ): unchanged when quiet, never past full scale.
    const float ceiling = 0.95f;
    float gain = peak > 0 ? MIN( MAX( 0.89f / peak, 0.2f / rms ), 32.0f ) / ceiling : 1;
    int n = (int)buffer.frameLength;
    for ( AVAudioChannelCount c = 0; c < channels; c++ ) {
      float *d = buffer.floatChannelData[c];
      vDSP_vsmul( d, 1, &gain, d, 1, buffer.frameLength );
      vvtanhf( d, d, &n );
      vDSP_vsmul( d, 1, &ceiling, d, 1, buffer.frameLength );
    }
    double rate = buffer.format.sampleRate;
    AVAudioFramePosition f0 = MIN( (AVAudioFramePosition)MAX( from * rate, 0 ), buffer.frameLength );
    AVAudioFramePosition f1 = to < 0
      ? buffer.frameLength
      : MAX( MIN( (AVAudioFramePosition)( to * rate ), buffer.frameLength ), f0 );
    if ( f0 > 0 || f1 < buffer.frameLength ) {
      AVAudioPCMBuffer *range = [[AVAudioPCMBuffer alloc]
        initWithPCMFormat:buffer.format frameCapacity:(AVAudioFrameCount)MAX( f1 - f0, 1 )];
      range.frameLength = (AVAudioFrameCount)( f1 - f0 );
      for ( AVAudioChannelCount c = 0; c < channels; c++ ) {
        memcpy( range.floatChannelData[c], buffer.floatChannelData[c] + f0,
                ( f1 - f0 ) * sizeof( float ) );
      }
      buffer = range;
    }
    AVAudioSession *session = [AVAudioSession sharedInstance];
    // Outside a listening session, a leftover record category (from an earlier
    // session, the camera or the sound recorder) would force the speaker.
    if ( !self->_engine ) {
      [session setCategory:AVAudioSessionCategoryPlayback error:nil];
      [session setActive:YES error:nil];
    }
    AVAudioEngine *engine = [AVAudioEngine new];
    AVAudioPlayerNode *node = [AVAudioPlayerNode new];
    [engine attachNode:node];
    [engine connect:node to:engine.mainMixerNode format:buffer.format];
    if ( ![engine startAndReturnError:&error] ) {
      reject( @"clip", error.localizedDescription ?: @"Could not play the clip", error );
      return;
    }
    self->_clipEngine = engine;
    self->_clipNode = node;
    self->_clipDone = resolve;
    [node scheduleBuffer:buffer atTime:nil options:0
      completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
           completionHandler:^( AVAudioPlayerNodeCompletionCallbackType type ) {
      dispatch_async( dispatch_get_main_queue(), ^{
        if ( self->_clipNode == node ) [self stopClipPlayback];
      } );
    }];
    [node play];
  } );
}

RCT_EXPORT_METHOD( stopClip )
{
  dispatch_async( dispatch_get_main_queue(), ^{ [self stopClipPlayback]; } );
}

- ( void )stopClipPlayback
{
  AVAudioPlayerNode *node = _clipNode;
  AVAudioEngine *engine = _clipEngine;
  RCTPromiseResolveBlock done = _clipDone;
  _clipNode = nil;
  _clipEngine = nil;
  _clipDone = nil;
  [node stop];
  [engine stop];
  if ( done ) done( nil );
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

// The phone's own vibration and sound playback reach the mic and get
// identified as birds, so the mic audio is zeroed while they play. Echo
// cancellation would need iOS voice processing, which also applies speech
// noise suppression and gain control that distort bird calls.
- (void)muteFor:(double)seconds
{
  CFAbsoluteTime until = CFAbsoluteTimeGetCurrent( ) + seconds;
  dispatch_async( _bufferQueue, ^{ self->_muteUntil = MAX( self->_muteUntil, until ); } );
}

RCT_EXPORT_METHOD( getBrightness:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    resolve( @( UIScreen.mainScreen.brightness ) );
  } );
}

RCT_EXPORT_METHOD( setBrightness:( double )value )
{
  dispatch_async( dispatch_get_main_queue(), ^{ UIScreen.mainScreen.brightness = value; } );
}

// Measurement mode plays back far quieter through the speaker, so clips play
// in the default mode while listening; the mic is muted during playback anyway.
RCT_EXPORT_METHOD( setPlayingClip:( BOOL )playing )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    // The tail covers speaker latency and the playback listener reporting the end late.
    if ( self->_playingClip && !playing ) [self muteFor:1];
    self->_playingClip = playing;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    if ( [session.category isEqualToString:AVAudioSessionCategoryPlayAndRecord] ) {
      [session setMode:playing ? AVAudioSessionModeDefault : AVAudioSessionModeMeasurement
                 error:nil];
    }
  } );
}

// Vibrates for a detection. Core Haptics ignores the silent switch but iOS
// stops it once the app leaves the foreground, so the background uses the
// system vibration, which plays with the screen off while recording keeps the
// app running. Mode "core" or "system" forces one, anything else picks by app state.
RCT_EXPORT_METHOD( vibrate:( NSString * )mode
                   resolve:( RCTPromiseResolveBlock )resolve
                   reject:( RCTPromiseRejectBlock )reject )
{
  dispatch_async( dispatch_get_main_queue(), ^{
    AVAudioSession *session = [AVAudioSession sharedInstance];
    NSError *error = nil;
    [session setAllowHapticsAndSystemSoundsDuringRecording:YES error:nil];
    UIApplicationState state = UIApplication.sharedApplication.applicationState;
    BOOL core = [mode isEqualToString:@"core"]
      || ( ![mode isEqualToString:@"system"] && state == UIApplicationStateActive );
    [self muteFor:0.7];
    if ( core ) {
      [self playCoreHaptics:session error:&error];
    } else {
      AudioServicesPlayAlertSound( kSystemSoundID_Vibrate );
    }
    resolve( @{
      @"allowed": @( session.allowHapticsAndSystemSoundsDuringRecording ),
      @"error": error ? error.localizedDescription : [NSNull null],
      @"method": core ? @"core" : @"system",
      @"appState": @( state ),
    } );
  } );
}

- (void)playCoreHaptics:(AVAudioSession *)session error:(NSError **)error
{
  if ( !_haptics ) {
    _haptics = [[CHHapticEngine alloc] initWithAudioSession:session error:error];
    if ( !_haptics ) return;
    _haptics.playsHapticsOnly = YES;
    _haptics.autoShutdownEnabled = YES;
    __weak AudioBirdId *weakSelf = self;
    _haptics.resetHandler = ^{
      AudioBirdId *me = weakSelf;
      if ( me ) me->_haptics = nil;
    };
    _haptics.stoppedHandler = ^( CHHapticEngineStoppedReason reason ) {
      // Idle auto shutdown is routine; anything else explains a missed buzz.
      if ( reason != CHHapticEngineStoppedReasonIdleTimeout ) {
        [weakSelf status:[NSString stringWithFormat:@"haptics stopped, reason %ld",
                          (long)reason]];
      }
    };
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
    initWithEvents:@[buzz] parameters:@[] error:error];
  id<CHHapticPatternPlayer> player = pattern
    ? [_haptics createPlayerWithPattern:pattern error:error]
    : nil;
  if ( player && [_haptics startAndReturnError:error] ) {
    [player startAtTime:CHHapticTimeImmediate error:error];
  }
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
  // A2DP plays clips through Bluetooth headphones while the built-in mic
  // keeps recording; the HFP option would also switch to the headset mic.
  if ( ![session setCategory:AVAudioSessionCategoryPlayAndRecord
                        mode:_playingClip ? AVAudioSessionModeDefault
                                          : AVAudioSessionModeMeasurement
                     options:AVAudioSessionCategoryOptionMixWithOthers
                           | AVAudioSessionCategoryOptionDefaultToSpeaker
                           | AVAudioSessionCategoryOptionAllowBluetoothA2DP
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
    // The tap's thread has no autorelease pool that drains while listening.
    @autoreleasepool {
      [weakSelf handleBuffer:buffer inRate:inFormat.sampleRate];
    }
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
    if ( self->_playingClip || CFAbsoluteTimeGetCurrent( ) < self->_muteUntil ) {
      memset( self->_window + AB_HIST - count, 0, count * sizeof( float ) );
    } else {
      memcpy( self->_window + AB_HIST - count, s, count * sizeof( float ) );
    }
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
    dispatch_async( self->_inferQueue, ^{
      NSString *inferError = nil;
      NSData *frames = nil;
      NSInteger frameCount = 0;
      CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent( );
      NSData *probs = [self run:self->_session input:(const float *)window.bytes length:AB_WIN
                      inputName:"input" outputName:"output" outputs:self->_outputs
                         frames:&frames frameCount:&frameCount error:&inferError];
      if ( frames ) {
        [self->_frameRuns addObject:@[@( windowFrame ), frames, @( frameCount )]];
        if ( self->_frameRuns.count > AB_FRAME_RUNS ) [self->_frameRuns removeObjectAtIndex:0];
      }
      double ms = ( CFAbsoluteTimeGetCurrent( ) - t0 ) * 1000;
      dispatch_async( self->_bufferQueue, ^{ self->_busy = NO; } );
      // By output index. Scores below the minimum can't count as heard, so
      // only the top one goes along with them, rather than one per species.
      const float *p = (const float *)probs.bytes;
      NSUInteger n = probs.length / sizeof( float ), top = 0;
      NSMutableDictionary<NSString *, NSNumber *> *scores = [NSMutableDictionary dictionary];
      for ( NSUInteger i = 0; i < n; i++ ) {
        if ( p[i] > p[top] ) top = i;
        if ( p[i] >= self->_minScore ) scores[[@( i ) stringValue]] = @( p[i] );
      }
      if ( n > 0 ) scores[[@( top ) stringValue]] = @( p[top] );
      [self sendEventWithName:@"AudioBirdIdScores"
                         body:@{ @"scores": scores,
                                 @"level": @( level ),
                                 @"windowFrame": @( windowFrame ),
                                 @"inferMs": @( ms ),
                                 @"memMB": @( [self footprintMB] ),
                                 @"spectrogramViews": @( abSpecViews ),
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

- (NSData *)run:(OrtSession *)session input:(const float *)samples
         length:(int64_t)length inputName:(const char *)inputName
     outputName:(const char *)outputName outputs:(NSArray<NSNumber *> *)outputs
          error:(NSString **)errorMessage
{
  return [self run:session input:samples length:length inputName:inputName
        outputName:outputName outputs:outputs frames:NULL frameCount:NULL error:errorMessage];
}

// One run of a [1, length] -> [1, n] model; returns the outputs listed in
// `outputs`, in that order, or all of them when it is nil, as floats. With
// `frames`, also sets it to those outputs' rows of the model's [1, n, T]
// "frames" output, and `frameCount` to T.
- (NSData *)run:(OrtSession *)session input:(const float *)samples
         length:(int64_t)length inputName:(const char *)inputName
     outputName:(const char *)outputName outputs:(NSArray<NSNumber *> *)outputs
         frames:(NSData **)frames frameCount:(NSInteger *)frameCount
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
  const char *outputNames[] = { outputName, "frames" };
  OrtValue *values[2] = { NULL, NULL };
  status = ort->Run( session, NULL, inputNames, (const OrtValue *const *)&input, 1,
                     outputNames, frames ? 2 : 1, values );
  ort->ReleaseValue( input );
  OrtValue *output = values[0];
  if ( status || !output ) {
    if ( status ) {
      *errorMessage = @( ort->GetErrorMessage( status ) );
      ort->ReleaseStatus( status );
    }
    if ( output ) ort->ReleaseValue( output );
    if ( values[1] ) ort->ReleaseValue( values[1] );
    return nil;
  }
  if ( values[1] ) {
    OrtTensorTypeAndShapeInfo *frameInfo;
    ort->GetTensorTypeAndShape( values[1], &frameInfo );
    int64_t dims[3] = { 0, 0, 0 };
    size_t ndims = 0;
    ort->GetDimensionsCount( frameInfo, &ndims );
    if ( ndims == 3 ) ort->GetDimensions( frameInfo, dims, 3 );
    ort->ReleaseTensorTypeAndShapeInfo( frameInfo );
    float *f;
    ort->GetTensorMutableData( values[1], (void **)&f );
    int64_t n = dims[1], t = dims[2];
    NSUInteger rows = outputs ? outputs.count : (NSUInteger)n;
    NSMutableData *rowsData = [NSMutableData dataWithLength:rows * t * sizeof( float )];
    float *dst = (float *)rowsData.mutableBytes;
    for ( NSUInteger r = 0; r < rows; r++ ) {
      int64_t k = outputs ? outputs[r].longLongValue : (int64_t)r;
      if ( k < n ) memcpy( dst + r * t, f + k * t, t * sizeof( float ) );
    }
    *frames = rowsData;
    *frameCount = (NSInteger)t;
    ort->ReleaseValue( values[1] );
  }

  OrtTensorTypeAndShapeInfo *info;
  ort->GetTensorTypeAndShape( output, &info );
  size_t count = 0;
  ort->GetTensorShapeElementCount( info, &count );
  ort->ReleaseTensorTypeAndShapeInfo( info );
  float *probs;
  ort->GetTensorMutableData( output, (void **)&probs );
  NSMutableData *scores = [NSMutableData dataWithLength:( outputs ? outputs.count : count )
                                                        * sizeof( float )];
  float *dst = (float *)scores.mutableBytes;
  if ( outputs ) {
    for ( NSNumber *i in outputs ) {
      size_t k = i.unsignedIntegerValue;
      *dst++ = k < count ? probs[k] : 0;
    }
  } else {
    memcpy( dst, probs, count * sizeof( float ) );
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
  NSInteger      _drawnCount; // columns drawn into strips, -1 for none
  NSInteger      _base;       // the column at x = 0 in _strips
  CALayer       *_strips;     // one sublayer per batch of new columns, oldest first
  NSMutableArray<CALayer *> *_spare; // strips that scrolled off, for reuse
  CGSize         _stripSize;  // the bounds the strips were laid out for
}

// Each batch of new columns is drawn once, into a strip a few columns wide,
// and the strips scroll left until they leave the view. This used to redraw
// the whole 10 s into a new full-size image on every frame, and the app's
// footprint climbed in a sawtooth to the 3.4GB limit within half an hour of
// listening -- seven times on Oct 15-17 -- and the app was killed there.
- (instancetype)initWithFrame:(CGRect)frame
{
  if ( ( self = [super initWithFrame:frame] ) ) {
    self.backgroundColor = UIColor.whiteColor;
    self.clipsToBounds = YES;
    _strips = [CALayer layer];
    [self.layer addSublayer:_strips];
    _spare = [NSMutableArray array];
    _drawnCount = -1;
  }
  return self;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  if ( CGSizeEqualToSize( self.bounds.size, _stripSize ) ) return;
  _stripSize = self.bounds.size;
  [self restart];
}

// Drops every strip, so the next tick redraws the last 10 s from the ring.
- (void)restart
{
  while ( _strips.sublayers.count ) [self recycle:_strips.sublayers.firstObject];
  _drawnCount = -1;
}

// Takes a strip off screen and keeps it, without its image, for the next
// batch of columns, so a long session reuses the same few dozen layers.
- (void)recycle:(CALayer *)strip
{
  [strip removeFromSuperlayer];
  strip.contents = nil;
  [_spare addObject:strip];
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if ( _link ) abSpecViews -= 1;
  [_link invalidate];
  _link = nil;
  if ( !self.window ) return;
  [self restart];
  _link = [CADisplayLink displayLinkWithTarget:self selector:@selector( tick )];
  _link.preferredFrameRateRange = CAFrameRateRangeMake( 30, 60, 60 );
  abSpecViews += 1;
  [_link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
}

- (void)tick
{
  CGFloat colW = _stripSize.width / AB_SPEC_W;
  CGFloat h    = _stripSize.height;
  if ( colW <= 0 || h <= 0 ) return;

  os_unfair_lock_lock( &abSpecLock );
  NSInteger count = abSpecCount;
  // Listening restarted, and the ring with it.
  if ( count < _drawnCount ) [self restart];
  if ( count == _drawnCount ) {
    os_unfair_lock_unlock( &abSpecLock );
    return;
  }
  if ( _drawnCount < 0 ) _base = count - AB_SPEC_W;
  // From one column before the new ones, so neighbouring strips overlap
  // rather than leave a hairline gap where their edges round to pixels.
  NSInteger first = MAX( MAX( _drawnCount - 1, count - AB_SPEC_W ), 0 );
  NSInteger width = count - first;
  uint8_t  *levels = width > 0 ? malloc( width * AB_SPEC_H ) : NULL;
  for ( NSInteger x = 0; x < width; x++ ) {
    memcpy( levels + x * AB_SPEC_H, abSpecLevel[( first + x ) % AB_SPEC_W], AB_SPEC_H );
  }
  os_unfair_lock_unlock( &abSpecLock );
  _drawnCount = count;

  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  // Keep coordinates small over a long session.
  NSInteger shift = count - AB_SPEC_W - _base;
  if ( shift > AB_SPEC_W * 10 ) {
    for ( CALayer *strip in _strips.sublayers ) {
      strip.frame = CGRectOffset( strip.frame, -shift * colW, 0 );
    }
    _base += shift;
  }
  // Newest column at the right edge; strips that scrolled off the left are
  // recycled, oldest first, to draw the new columns at the right.
  CGFloat left = ( count - AB_SPEC_W - _base ) * colW;
  while ( _strips.sublayers.count
          && CGRectGetMaxX( _strips.sublayers.firstObject.frame ) <= left ) {
    [self recycle:_strips.sublayers.firstObject];
  }
  if ( levels ) {
    CGImageRef image = ABSpectrogramImage( levels, width );
    free( levels );
    CALayer *strip = _spare.lastObject ?: [CALayer layer];
    [_spare removeLastObject];
    strip.magnificationFilter = kCAFilterLinear;
    strip.contents = (__bridge id)image;
    strip.frame = CGRectMake( ( first - _base ) * colW, 0, width * colW, h );
    CGImageRelease( image );
    [_strips addSublayer:strip];
  }
  _strips.frame = CGRectMake( -left, 0, left + _stripSize.width, h );
  [CATransaction commit];
}

@end

@interface AudioSpectrogramManager : RCTViewManager
@end

@implementation AudioSpectrogramManager

RCT_EXPORT_MODULE( )

- (UIView *)view { return [AudioSpectrogramView new]; }

@end

// Draws the whole of the clip at `path` (32 kHz mono, as Audio ID saves them)
// as a spectrogram stretched to the view's width.
@interface AudioClipSpectrogramView : UIView
@property ( nonatomic, copy ) NSString *path;
@end

@implementation AudioClipSpectrogramView

- (void)setPath:(NSString *)path
{
  if ( [path isEqualToString:_path] ) return;
  _path = [path copy];
  self.layer.magnificationFilter = kCAFilterLinear;
  self.layer.contents = nil;
  __weak AudioClipSpectrogramView *weakSelf = self;
  dispatch_async( dispatch_get_global_queue( QOS_CLASS_USER_INITIATED, 0 ), ^{
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] error:nil];
    AVAudioPCMBuffer *buffer = file
      ? [[AVAudioPCMBuffer alloc] initWithPCMFormat:file.processingFormat
                                      frameCapacity:(AVAudioFrameCount)file.length]
      : nil;
    if ( !buffer || ![file readIntoBuffer:buffer error:nil]
         || buffer.frameLength < AB_SPEC_N ) return;
    NSInteger width = ( buffer.frameLength - AB_SPEC_N ) / AB_SPEC_HOP + 1;
    uint8_t *levels = malloc( width * AB_SPEC_H );
    for ( NSInteger x = 0; x < width; x++ ) {
      ABSpectrogramColumn( buffer.floatChannelData[0] + x * AB_SPEC_HOP, levels + x * AB_SPEC_H );
    }
    CGImageRef image = ABSpectrogramImage( levels, width );
    free( levels );
    dispatch_async( dispatch_get_main_queue( ), ^{
      AudioClipSpectrogramView *view = weakSelf;
      if ( view && [view.path isEqualToString:path] ) view.layer.contents = (__bridge id)image;
      CGImageRelease( image );
    } );
  } );
}

@end

@interface AudioClipSpectrogramManager : RCTViewManager
@end

@implementation AudioClipSpectrogramManager

RCT_EXPORT_MODULE( )

RCT_EXPORT_VIEW_PROPERTY( path, NSString )

- (UIView *)view { return [AudioClipSpectrogramView new]; }

@end
