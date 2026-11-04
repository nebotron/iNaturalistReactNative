import type { EbirdInatObservation } from "api/ebird";
import useEbirdObservations from "components/Explore/hooks/useEbirdObservations";
import React, { useMemo } from "react";
import { Linking } from "react-native";
import { Marker } from "react-native-maps";
import colors from "styles/tailwindColors";

interface Props {
  params: Record<string, unknown>;
}

// One pin per eBird location, listing the species seen there
const EbirdMapMarkers = ( { params }: Props ) => {
  const observations = useEbirdObservations( params )?.observations;
  const locations = useMemo( ( ) => {
    const byLocation = new Map<string, EbirdInatObservation[]>( );
    ( observations || [] ).forEach( obs => {
      const key = `${obs.latitude},${obs.longitude}`;
      byLocation.set( key, [...( byLocation.get( key ) || [] ), obs] );
    } );
    return [...byLocation.entries( )];
  }, [observations] );
  return locations.map( ( [key, obsAtLocation] ) => {
    const [first] = obsAtLocation;
    return (
      <Marker
        key={key}
        coordinate={{ latitude: first.latitude as number, longitude: first.longitude as number }}
        description={obsAtLocation.map( obs => obs.taxon?.preferred_common_name ).join( ", " )}
        onCalloutPress={( ) => Linking.openURL( first.ebirdChecklistUrl )}
        pinColor={colors.blue}
        testID="EbirdMapMarker"
        title={first.place_guess}
        tracksViewChanges={false}
      />
    );
  } );
};

export default EbirdMapMarkers;
