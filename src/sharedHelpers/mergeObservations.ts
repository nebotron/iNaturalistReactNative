import type Realm from "realm";
import Photo from "realmModels/Photo";
import Sound from "realmModels/Sound";
import type { RealmObservation } from "realmModels/types";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";
import * as uuid from "uuid";

// Plain copy of an embedded Realm object
const copyEmbedded = (
  record: Record<string, unknown>,
  schema: { properties: Record<string, unknown> },
) => Object.fromEntries( Object.keys( schema.properties ).map( key => [key, record[key]] ) );

// Moves every photo and sound of `sources` onto `target`, fills fields the
// target is missing, and deletes the sources. Media is copied as new,
// unsynced evidence so the next upload attaches it to the target. Sources
// that exist on the server are deleted there only once the target has
// synced, so the server never orphans (and destroys) their photos first.
const mergeObservations = (
  realm: Realm,
  target: RealmObservation,
  sources: RealmObservation[],
) => {
  const now = new Date( );
  const syncedSourceUuids = sources.filter( s => s._synced_at ).map( s => s.uuid );
  safeRealmWrite( realm, ( ) => {
    let position = target.observationPhotos.length;
    sources.forEach( source => {
      source.observationPhotos.forEach( op => {
        if ( !op.photo ) return;
        target.observationPhotos.push( {
          uuid: uuid.v4( ),
          _created_at: now,
          _updated_at: now,
          _synced_at: null,
          originalDevicePhotoUri: op.originalDevicePhotoUri,
          position,
          photo: copyEmbedded( op.photo, Photo.schema ),
        } );
        position += 1;
      } );
      source.observationSounds.forEach( os => {
        if ( !os.sound ) return;
        target.observationSounds.push( {
          uuid: uuid.v4( ),
          _created_at: now,
          _updated_at: now,
          _synced_at: null,
          sound: copyEmbedded( os.sound, Sound.schema ),
        } );
      } );
      if ( !target.taxon && source.taxon ) {
        target.taxon = source.taxon;
        target.species_guess = source.species_guess;
      }
      if ( target.latitude == null && source.latitude != null ) {
        target.latitude = source.latitude;
        target.longitude = source.longitude;
        target.positional_accuracy = source.positional_accuracy;
        target.place_guess = source.place_guess;
      }
      if ( !target.observed_on_string && source.observed_on_string ) {
        target.observed_on_string = source.observed_on_string;
      }
      if ( !target.description && source.description ) {
        target.description = source.description;
      }
    } );
    target._updated_at = now;
    target.needs_sync = true;
    sources.forEach( source => realm.delete( source ) );
  }, "merging observations" );
  if ( syncedSourceUuids.length > 0 ) {
    useStore.getState( ).addMergeDeletions( syncedSourceUuids, target.uuid );
  }
};

export default mergeObservations;
