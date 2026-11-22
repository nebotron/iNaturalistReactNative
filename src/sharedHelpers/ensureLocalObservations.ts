import { fetchRemoteObservations } from "api/observations";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type Realm from "realm";
import Observation from "realmModels/Observation";

// Copies the user's own observations that are only on the server (e.g. ones selected in
// Explore) into Realm, so they can be combined or deleted like the ones in My Observations
const ensureLocalObservations = async ( realm: Realm, uuids: string[] ) => {
  const missing = uuids.filter( u => !realm.objectForPrimaryKey( "Observation", u ) );
  if ( missing.length === 0 ) return;
  const apiToken = await getJWT( );
  if ( !apiToken ) {
    throw new Error( "Changing uploaded observations requires being signed in" );
  }
  const remoteObservations = await fetchRemoteObservations(
    missing,
    { fields: Observation.FIELDS },
    { api_token: apiToken },
  );
  if ( !remoteObservations || remoteObservations.length < missing.length ) {
    throw new Error( "Couldn't load the selected observations" );
  }
  Observation.upsertRemoteObservations( remoteObservations, realm );
};

export default ensureLocalObservations;
