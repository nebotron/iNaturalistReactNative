import { deleteRemoteObservation } from "api/observations";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import type { RealmObservation } from "realmModels/types";

// Deletes every observation in uuids, on the server too when it has been uploaded
const deleteObservations = async ( realm: Realm, uuids: string[] ) => {
  const observations = uuids
    .map( u => realm.objectForPrimaryKey<RealmObservation>( "Observation", u ) )
    .filter( ( o ): o is RealmObservation => !!o );
  const syncedUuids = observations.filter( o => o._synced_at ).map( o => o.uuid );
  const apiToken = syncedUuids.length > 0 && await getJWT( );
  if ( syncedUuids.length > 0 && !apiToken ) {
    throw new Error( "Deleting uploaded observations requires being signed in" );
  }
  observations
    .filter( o => !syncedUuids.includes( o.uuid ) )
    .forEach( o => Observation.deleteLocalObservation( realm, o.uuid ) );
  await Promise.all( syncedUuids.map( async u => {
    await deleteRemoteObservation( { uuid: u }, { api_token: apiToken } );
    Observation.deleteLocalObservation( realm, u );
  } ) );
};

export default deleteObservations;
