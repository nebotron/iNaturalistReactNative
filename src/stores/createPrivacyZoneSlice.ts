// A "privacy zone" is a circle the user draws around a place they don't want
// to publish precise coordinates for (their house, a nest site, etc.).
// Observations saved inside it get their geoprivacy set to obscured
// automatically. This is purely a client-side rule; iNaturalist itself has no
// per-user geofence, and no account-level default geoprivacy.

export const DEFAULT_PRIVACY_ZONE_RADIUS_METERS = 500;

export const PRIVACY_ZONE_RADIUS_OPTIONS_METERS = [100, 250, 500, 1000, 5000];

export interface PrivacyZone {
  enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number;
}

const createPrivacyZoneSlice = set => ( {
  privacyZone: {
    enabled: false,
    latitude: null as number | null,
    longitude: null as number | null,
    radiusMeters: DEFAULT_PRIVACY_ZONE_RADIUS_METERS,
    setPrivacyZoneEnabled: ( enabled: boolean ) => set( state => ( {
      privacyZone: {
        ...state.privacyZone,
        enabled,
      },
    } ) ),
    setPrivacyZoneCenter: ( center: { latitude: number; longitude: number } ) => set( state => ( {
      privacyZone: {
        ...state.privacyZone,
        latitude: center.latitude,
        longitude: center.longitude,
        // Setting a center for the first time is only ever done in order to
        // use it, so turn the zone on rather than making the user find a
        // second control.
        enabled: true,
      },
    } ) ),
    clearPrivacyZoneCenter: ( ) => set( state => ( {
      privacyZone: {
        ...state.privacyZone,
        latitude: null,
        longitude: null,
        enabled: false,
      },
    } ) ),
    setPrivacyZoneRadiusMeters: ( radiusMeters: number ) => set( state => ( {
      privacyZone: {
        ...state.privacyZone,
        radiusMeters,
      },
    } ) ),
  },
} );

export default createPrivacyZoneSlice;
