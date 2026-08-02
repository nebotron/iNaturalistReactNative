import type Realm from "realm";
import distanceInMeters from "sharedHelpers/geoDistance";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import type { PrivacyZone } from "stores/createPrivacyZoneSlice";
import useStore from "stores/useStore";

// Duplicated from realmModels/Observation so that model can import this helper
// without a circular import.
const GEOPRIVACY_OPEN = "open";
const GEOPRIVACY_OBSCURED = "obscured";
const GEOPRIVACY_PRIVATE = "private";

interface LocatableObservation {
  latitude?: number | null;
  longitude?: number | null;
  geoprivacy?: string | null;
}

// Observations the privacy zone could still tighten: they have a location, and
// their geoprivacy hasn't already been set to something at least as private.
// Excludes observations pending deletion. Note this deliberately says nothing
// about taxon_geoprivacy, which the server applies on top of ours.
//
// Restricted to observations that have never been uploaded, because those are
// the only ones whose Realm coordinates can be trusted: list responses from the
// API don't include geojson, so synced observations are stored here with no
// latitude at all. Already-uploaded observations in the zone are found through
// the API instead — see privacyZonePastObservations.
export const PRIVACY_ZONE_LOCAL_CANDIDATE_FILTER
  = "( _deleted_at == nil OR _pending_deletion == false OR _pending_deletion == nil ) "
  + "AND _synced_at == nil "
  + "AND latitude != nil AND longitude != nil "
  + `AND ( geoprivacy == nil OR geoprivacy == "${GEOPRIVACY_OPEN}" )`;

export const getPrivacyZone = ( ): PrivacyZone => useStore.getState( ).privacyZone;

export const isPrivacyZoneActive = ( zone: PrivacyZone = getPrivacyZone( ) ): boolean => (
  !!zone?.enabled && zone.latitude != null && zone.longitude != null
);

export const isInPrivacyZone = (
  latitude?: number | null,
  longitude?: number | null,
  zone: PrivacyZone = getPrivacyZone( ),
): boolean => {
  if ( !isPrivacyZoneActive( zone ) ) return false;
  if ( latitude == null || longitude == null ) return false;
  return distanceInMeters(
    latitude,
    longitude,
    zone.latitude as number,
    zone.longitude as number,
  ) <= zone.radiusMeters;
};

// The geoprivacy an observation should have because of the privacy zone, or
// null when the zone shouldn't change it. Only ever tightens geoprivacy:
// observations the user already obscured or made private are left alone.
export const privacyZoneGeoprivacy = (
  observation: LocatableObservation | null | undefined,
  zone: PrivacyZone = getPrivacyZone( ),
): string | null => {
  if ( !observation ) return null;
  const { geoprivacy } = observation;
  if ( geoprivacy === GEOPRIVACY_OBSCURED || geoprivacy === GEOPRIVACY_PRIVATE ) return null;
  if ( !isInPrivacyZone( observation.latitude, observation.longitude, zone ) ) return null;
  return GEOPRIVACY_OBSCURED;
};

// Obscures already-saved observations in a single write, and bumps their
// timestamps so the normal upload flow pushes the change to iNaturalist (as a
// create for local-only observations, or an update with ignore_photos for
// observations that have already been uploaded). Returns the observations that
// actually changed, for the caller to queue for upload.
export const obscureObservationsInPrivacyZone = <T extends LocatableObservation & {
  uuid: string;
}>(
    realm: Realm,
    observations: T[],
  ): T[] => {
  const zone = getPrivacyZone( );
  const toObscure = observations.filter( obs => !!privacyZoneGeoprivacy( obs, zone ) );
  if ( toObscure.length === 0 ) return [];

  safeRealmWrite( realm, ( ) => {
    toObscure.forEach( obs => {
      const mutableObs = obs as T & {
        geoprivacy?: string;
        _updated_at?: Date;
        needs_sync?: boolean;
      };
      mutableObs.geoprivacy = GEOPRIVACY_OBSCURED;
      mutableObs._updated_at = new Date( );
      mutableObs.needs_sync = true;
    } );
  }, "obscuring observations in the privacy zone" );

  return toObscure;
};
