import type { EbirdObservation } from "api/ebird";
import useEbirdObservations from "components/Explore/hooks/useEbirdObservations";
import React, { useMemo } from "react";
import { Linking } from "react-native";
import { Marker } from "react-native-maps";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

interface Props {
  params: Record<string, unknown>;
}

// One pin per eBird location, listing the species seen there
const EbirdMapMarkers = ( { params }: Props ) => {
  const ebirdEnabled = useStore( state => state.layout.ebirdEnabled );
  const ebird = useEbirdObservations( params, ebirdEnabled );
  const observations = ebird?.observations;
  const locations = useMemo( ( ) => {
    const byLocation = new Map<string, EbirdObservation[]>( );
    ( observations || [] ).forEach( obs => {
      const key = `${obs.lat},${obs.lng}`;
      byLocation.set( key, [...( byLocation.get( key ) || [] ), obs] );
    } );
    return [...byLocation.entries( )];
  }, [observations] );
  if ( !ebirdEnabled || !ebird ) return null;
  return locations.map( ( [key, obsAtLocation] ) => {
    const [first] = obsAtLocation;
    return (
      <Marker
        key={key}
        coordinate={{ latitude: first.lat, longitude: first.lng }}
        description={obsAtLocation.map( obs => obs.comName ).join( ", " )}
        onCalloutPress={( ) => Linking.openURL( `https://ebird.org/checklist/${first.subId}` )}
        pinColor={colors.blue}
        testID="EbirdMapMarker"
        title={first.locName}
        tracksViewChanges={false}
      />
    );
  } );
};

export default EbirdMapMarkers;
