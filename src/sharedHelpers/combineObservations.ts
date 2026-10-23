import { deleteRemoteObservation } from "api/observations";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import Sound from "realmModels/Sound";
import type { RealmObservation } from "realmModels/types";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import uploadObservation from "uploaders/observationUploader";
import * as uuid from "uuid";

// Plain copy of an embedded Photo or Sound, so it can be pushed onto another observation
const copyEmbedded = ( record, schema: { properties: object } ) => record && Object.fromEntries(
  Object.keys( schema.properties ).map( key => [key, record[key]] ),
);

// Moves the photos and sounds of every observation in uuids onto one of them and deletes the
// rest. Uploaded observations are combined on the server right away, so this needs a
// connection when any of them have been uploaded. Returns the uuid of the observation kept.
const combineObservations = async ( realm: Realm, uuids: string[] ): Promise<string> => {
  const observations = uuids
    .map( u => realm.objectForPrimaryKey<RealmObservation>( "Observation", u ) )
    .filter( ( o ): o is RealmObservation => !!o );
  // Keep an uploaded observation when there is one, so its identifications and comments survive
  const target = observations.find( o => o._synced_at ) || observations[0];
  const sources = observations.filter( o => o.uuid !== target.uuid );
  const syncedSourceUuids = sources.filter( o => o._synced_at ).map( o => o.uuid );
  if ( syncedSourceUuids.length > 0 && !await getJWT( ) ) {
    throw new Error( "Combining uploaded observations requires being signed in" );
  }

  safeRealmWrite( realm, ( ) => {
    let position = target.observationPhotos.length;
    sources.forEach( source => {
      source.observationPhotos.forEach( op => {
        target.observationPhotos.push( {
          uuid: uuid.v4( ),
          _created_at: new Date( ),
          originalDevicePhotoUri: op.originalDevicePhotoUri,
          photo: copyEmbedded( op.photo, Photo.schema ),
          position,
        } );
        position += 1;
      } );
      source.observationSounds.forEach( os => {
        target.observationSounds.push( {
          uuid: uuid.v4( ),
          _created_at: new Date( ),
          sound: copyEmbedded( os.sound, Sound.schema ),
        } );
      } );
      // Fill in whatever the kept observation is missing
      if ( !target.taxon && source.taxon ) {
        target.taxon = source.taxon;
      }
      if ( target.latitude == null && source.latitude != null ) {
        target.latitude = source.latitude;
        target.longitude = source.longitude;
        target.positional_accuracy = source.positional_accuracy;
        target.place_guess = source.place_guess;
      }
      if ( !target.observed_on_string && source.observed_on_string ) {
        target.observed_on_string = source.observed_on_string;
        target.observed_on = source.observed_on;
        target.time_observed_at = source.time_observed_at;
      }
    } );
    target._updated_at = new Date( );
    target.needs_sync = true;
  }, "combining observations" );

  sources
    .filter( o => !syncedSourceUuids.includes( o.uuid ) )
    .forEach( o => Observation.deleteLocalObservation( realm, o.uuid ) );

  if ( syncedSourceUuids.length > 0 ) {
    // Attach the media to the kept observation before deleting the others on the server, so
    // photos shared between them are never left orphaned
    await uploadObservation( target, realm, { signal: new AbortController( ).signal } );
    const apiToken = await getJWT( );
    await Promise.all( syncedSourceUuids.map( async sourceUuid => {
      await deleteRemoteObservation( { uuid: sourceUuid }, { api_token: apiToken } );
      Observation.deleteLocalObservation( realm, sourceUuid );
    } ) );
  }
  return target.uuid;
};

export default combineObservations;
