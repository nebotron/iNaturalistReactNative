import Observation from "realmModels/Observation";

/**
 * The params ObsDetails asks an observation for.
 *
 * Shared with the notification prefetch, and shaped — key order included — so
 * both produce byte-identical requests. The HTTP cache keys on the request
 * itself, so a prefetch differing by so much as a reordered key would warm
 * nothing the screen later asks for.
 */
const remoteObservationParams = ( locale?: string ) => ( {
  include_new_projects: true,
  ...( locale && { locale } ),
  fields: Observation.FIELDS,
} );

export default remoteObservationParams;
