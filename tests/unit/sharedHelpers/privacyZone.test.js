import {
  isInPrivacyZone,
  isPrivacyZoneActive,
  privacyZoneGeoprivacy,
} from "sharedHelpers/privacyZone";
import useStore from "stores/useStore";

const initialStoreState = useStore.getState( );

// Berkeley, CA
const HOME = { latitude: 37.87159, longitude: -122.27275 };
// ~230 m north of HOME
const NEARBY = { latitude: 37.8736, longitude: -122.27275 };
// ~3.5 km east of HOME
const FAR_AWAY = { latitude: 37.87159, longitude: -122.23275 };

const setZone = zone => useStore.setState( {
  privacyZone: {
    ...useStore.getState( ).privacyZone,
    ...zone,
  },
} );

describe( "privacyZone", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
  } );

  describe( "isPrivacyZoneActive", ( ) => {
    it( "is inactive by default", ( ) => {
      expect( isPrivacyZoneActive( ) ).toBe( false );
    } );

    it( "is inactive when enabled without a center", ( ) => {
      setZone( { enabled: true } );
      expect( isPrivacyZoneActive( ) ).toBe( false );
    } );

    it( "is active when enabled with a center", ( ) => {
      setZone( { enabled: true, ...HOME } );
      expect( isPrivacyZoneActive( ) ).toBe( true );
    } );
  } );

  describe( "isInPrivacyZone", ( ) => {
    beforeEach( ( ) => setZone( { enabled: true, ...HOME, radiusMeters: 500 } ) );

    it( "includes coordinates within the radius", ( ) => {
      expect( isInPrivacyZone( NEARBY.latitude, NEARBY.longitude ) ).toBe( true );
    } );

    it( "excludes coordinates beyond the radius", ( ) => {
      expect( isInPrivacyZone( FAR_AWAY.latitude, FAR_AWAY.longitude ) ).toBe( false );
    } );

    it( "excludes observations without coordinates", ( ) => {
      expect( isInPrivacyZone( null, null ) ).toBe( false );
    } );

    it( "excludes everything when the zone is disabled", ( ) => {
      setZone( { enabled: false } );
      expect( isInPrivacyZone( NEARBY.latitude, NEARBY.longitude ) ).toBe( false );
    } );

    it( "respects a larger radius", ( ) => {
      setZone( { radiusMeters: 5000 } );
      expect( isInPrivacyZone( FAR_AWAY.latitude, FAR_AWAY.longitude ) ).toBe( true );
    } );
  } );

  describe( "privacyZoneGeoprivacy", ( ) => {
    beforeEach( ( ) => setZone( { enabled: true, ...HOME, radiusMeters: 500 } ) );

    it( "obscures an open observation inside the zone", ( ) => {
      expect( privacyZoneGeoprivacy( { ...NEARBY, geoprivacy: "open" } ) ).toEqual( "obscured" );
    } );

    it( "obscures an observation with no geoprivacy yet", ( ) => {
      expect( privacyZoneGeoprivacy( { ...NEARBY, geoprivacy: null } ) ).toEqual( "obscured" );
    } );

    it( "leaves observations outside the zone alone", ( ) => {
      expect( privacyZoneGeoprivacy( { ...FAR_AWAY, geoprivacy: "open" } ) ).toBeNull( );
    } );

    it( "never loosens geoprivacy the user already tightened", ( ) => {
      expect( privacyZoneGeoprivacy( { ...NEARBY, geoprivacy: "private" } ) ).toBeNull( );
      expect( privacyZoneGeoprivacy( { ...NEARBY, geoprivacy: "obscured" } ) ).toBeNull( );
    } );
  } );
} );
