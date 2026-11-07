import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import * as uuid from "uuid";

import useAudioIdHistory, { contextClipPath } from "./audioIdHistory";
import { prepareAudioId } from "./audioIdModel";
import { AudioBirdId } from "./audioIdSession";

// Whether a shared sound can become an Audio ID clip on this device.
export const canImportSharedClip = ( ) => !!AudioBirdId?.importClip;

// Makes the sound at `uri` (e.g. a Voice Memo shared to the app) an Audio ID
// clip, identified by the model as the species likely here scoring highest,
// and resolves its id. The whole sound is kept, so the clip page can trim it.
const importSharedClip = async ( uri: string ): Promise<string> => {
  if ( !AudioBirdId?.importClip ) throw new Error( "Audio ID is unavailable" );
  const location = await fetchCoarseUserLocation( ).catch( ( ) => null );
  const setup = await prepareAudioId( AudioBirdId.geo, location );
  if ( setup.species.length === 0 ) throw new Error( "Audio ID has no species to identify" );
  const scores = await AudioBirdId.scoreSound( uri, setup.outputs );
  const best = scores.reduce( ( top, s, i ) => ( s > scores[top]
    ? i
    : top ), 0 );
  const id = uuid.v4( );
  const duration = await AudioBirdId.importClip( uri, contextClipPath( id ) );
  useAudioIdHistory.getState( ).addClip( setup.species[best], scores[best], {
    id,
    duration,
    call: [0, duration],
    ...( location
      ? {
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.positional_accuracy,
        },
      }
      : {} ),
  } );
  return id;
};

export default importSharedClip;
