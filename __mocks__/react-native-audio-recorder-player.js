/* eslint-disable class-methods-use-this, no-empty-function, @typescript-eslint/no-empty-function */
// This is just a mock, so these rules aren't helping much
export default class MockAudioRecorderPlayer {
  setSubscriptionDuration( ) { }

  // Playback. Anything rendering a sound calls these, and they have to exist or
  // the component throws instead of rendering.
  async startPlayer( ) { }

  async pausePlayer( ) { }

  async seekToPlayer( ) { }

  addPlayBackListener( ) { }

  removePlayBackListener( ) { }

  mmss( ) {
    return "00:00";
  }
}
