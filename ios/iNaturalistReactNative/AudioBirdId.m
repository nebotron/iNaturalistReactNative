#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#include "onnxruntime_c_api.h"

// Live bird identification by sound. Taps the microphone, resamples to
// 32 kHz mono, keeps the most recent 5 s in a sliding window, and every second
// runs audio_birds.onnx on it: BirdNET v3.0 (CC BY-SA 4.0, "Powered by
// BirdNET"), cut down to Seattle-area species by
// scripts/bird_audio/slice_birdnet.py. The model contains its own
// spectrogram frontend, so the window goes in as raw samples and one
// probability per species comes out (multi-label: several birds can score
// high at once). Scores are emitted to JS as "AudioBirdIdScores".

#define AB_SR       32000
#define AB_WIN      160000  // 5 s, BirdNET v3.0's input
#define AB_STEP     32000   // run every 1 s of new audio

@interface AudioBirdId : RCTEventEmitter <RCTBridgeModule>
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
  }
  return self;
}

- (void)dealloc
{
  [self stopEngine];
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  if ( _session ) ort->ReleaseSession( _session );
  if ( _env ) ort->ReleaseEnv( _env );
  free( _window );
}

- (BOOL)loadModel
{
  if ( _session ) return YES;
  NSString *path = [[NSBundle mainBundle] pathForResource:@"audio_birds" ofType:@"onnx"];
  if ( !path ) return NO;
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  if ( !_env && ort->CreateEnv( ORT_LOGGING_LEVEL_WARNING, "iNatAudio", &_env ) ) return NO;
  OrtSessionOptions *opts;
  if ( ort->CreateSessionOptions( &opts ) ) return NO;
  ort->SetIntraOpNumThreads( opts, 2 );
  OrtStatus *status = ort->CreateSession( _env, [path UTF8String], opts, &_session );
  ort->ReleaseSessionOptions( opts );
  if ( status ) { ort->ReleaseStatus( status ); _session = NULL; return NO; }
  return YES;
}

RCT_EXPORT_METHOD( start:( RCTPromiseResolveBlock )resolve
                   rejecter:( RCTPromiseRejectBlock )reject )
{
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
      if ( ![self startEngine:&error] ) {
        reject( @"engine", error.localizedDescription ?: @"Could not start the microphone", error );
        return;
      }
      resolve( @YES );
    } );
  }];
}

RCT_EXPORT_METHOD( stop )
{
  dispatch_async( dispatch_get_main_queue(), ^{ [self stopEngine]; } );
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

- (void)stopEngine
{
  if ( !_engine ) return;
  [_engine.inputNode removeTapOnBus:0];
  [_engine stop];
  _engine = nil;
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
    self->_sinceRun = 0;
    self->_busy = YES;
    NSData *window = [NSData dataWithBytes:self->_window length:AB_WIN * sizeof( float )];
    float level = self->_level;
    dispatch_async( self->_inferQueue, ^{
      NSArray *scores = [self infer:(const float *)window.bytes];
      dispatch_async( self->_bufferQueue, ^{ self->_busy = NO; } );
      if ( scores ) {
        [self sendEventWithName:@"AudioBirdIdScores"
                           body:@{ @"scores": scores, @"level": @( level ) }];
      }
    } );
  } );
}

- (NSArray<NSNumber *> *)infer:(const float *)samples
{
  const OrtApi *ort = OrtGetApiBase()->GetApi( ORT_API_VERSION );
  OrtMemoryInfo *memInfo;
  ort->CreateCpuMemoryInfo( OrtArenaAllocator, OrtMemTypeDefault, &memInfo );
  int64_t shape[] = { 1, AB_WIN };
  OrtValue *input = NULL;
  OrtStatus *status = ort->CreateTensorWithDataAsOrtValue(
    memInfo, (void *)samples, AB_WIN * sizeof( float ), shape, 2,
    ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &input );
  ort->ReleaseMemoryInfo( memInfo );
  if ( status ) { ort->ReleaseStatus( status ); return nil; }

  const char *inputNames[]  = { "input" };
  const char *outputNames[] = { "predictions" };
  OrtValue *output = NULL;
  status = ort->Run( _session, NULL, inputNames, (const OrtValue *const *)&input, 1,
                     outputNames, 1, &output );
  ort->ReleaseValue( input );
  if ( status || !output ) { if ( status ) ort->ReleaseStatus( status ); return nil; }

  OrtTensorTypeAndShapeInfo *info;
  ort->GetTensorTypeAndShape( output, &info );
  size_t count = 0;
  ort->GetTensorShapeElementCount( info, &count );
  ort->ReleaseTensorTypeAndShapeInfo( info );
  float *probs;
  ort->GetTensorMutableData( output, (void **)&probs );
  NSMutableArray *scores = [NSMutableArray arrayWithCapacity:count];
  for ( size_t i = 0; i < count; i++ ) [scores addObject:@( probs[i] )];
  ort->ReleaseValue( output );
  return scores;
}

@end
