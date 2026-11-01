import {
  Body2, Body3, Body4, Heading4,
} from "components/SharedComponents";
import { ScrollView, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useMemo } from "react";
import type { RealmObservation } from "realmModels/types";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { useTranslation } from "sharedHooks";

const { useQuery } = RealmContext;

type Field = "camera" | "lens" | "focalLength" | "aperture" | "shutterSpeed" | "iso"
  | "focusDistance";

// Upper bounds in meters; anything farther falls in the last bucket.
const DISTANCE_BUCKETS = [0.1, 0.3, 1, 3, 10];
const distanceBucket = ( value: string ) => {
  const meters = parseFloat( value );
  const index = DISTANCE_BUCKETS.findIndex( bound => meters < bound );
  if ( index === -1 ) return `≥ ${DISTANCE_BUCKETS[DISTANCE_BUCKETS.length - 1]} m`;
  return `${index === 0
    ? 0
    : DISTANCE_BUCKETS[index - 1]}–${DISTANCE_BUCKETS[index]} m`;
};

// Sort key for numeric settings, so they read as a histogram; "1/250 s" → 0.004
const numericValue = ( value: string ) => {
  const fraction = value.match( /^1\/(\d+)/ );
  if ( fraction ) return 1 / Number( fraction[1] );
  return parseFloat( value.replace( /^[^\d.]+/, "" ) );
};

const MAX_ROWS = 15;

const toIds = ( value: unknown ) => String( value ?? "" ).split( "," )
  .map( Number ).filter( Boolean );

interface Props {
  queryParams: Record<string, unknown>;
}

// How often each camera, lens and setting appears in the photos of matching
// observations. iNaturalist strips EXIF from the photos it hosts, so this
// reads the settings saved when photos were added on this device.
const CameraStatsView = ( { queryParams }: Props ) => {
  const { t } = useTranslation( );
  const observations = useQuery<RealmObservation>( "Observation" );
  const taxonIds = useMemo( ( ) => toIds( queryParams.taxon_id ), [queryParams.taxon_id] );

  const { photoCount, distributions } = useMemo( ( ) => {
    const counts: Record<Field, Map<string, number>> = {
      camera: new Map( ),
      lens: new Map( ),
      focalLength: new Map( ),
      aperture: new Map( ),
      shutterSpeed: new Map( ),
      iso: new Map( ),
      focusDistance: new Map( ),
    };
    let total = 0;
    observations.forEach( observation => {
      const { taxon } = observation;
      if ( taxonIds.length > 0 && !taxonIds.some( id => taxon?.id === id
        || taxon?.ancestor_ids?.includes( id ) ) ) return;
      observation.observationPhotos?.forEach( obsPhoto => {
        if ( !obsPhoto.cameraInfo ) return;
        let info: PhotoCameraInfo;
        try {
          info = JSON.parse( obsPhoto.cameraInfo );
        } catch {
          return;
        }
        total += 1;
        ( Object.keys( counts ) as Field[] ).forEach( field => {
          const raw = info[field];
          if ( !raw ) return;
          const value = field === "focusDistance"
            ? distanceBucket( raw )
            : raw;
          counts[field].set( value, ( counts[field].get( value ) ?? 0 ) + 1 );
        } );
      } );
    } );
    const sorted = ( Object.keys( counts ) as Field[] ).map( field => {
      const rows = [...counts[field].entries( )]
        .sort( ( a, b ) => b[1] - a[1] )
        .slice( 0, MAX_ROWS );
      if ( field !== "camera" && field !== "lens" ) {
        rows.sort( ( a, b ) => numericValue( a[0] ) - numericValue( b[0] ) );
      }
      return { field, rows };
    } );
    return { photoCount: total, distributions: sorted };
  }, [observations, taxonIds] );

  const labels: Record<Field, string> = {
    camera: t( "Camera" ),
    lens: t( "Lens" ),
    focalLength: t( "Focal-length" ),
    aperture: t( "Aperture" ),
    shutterSpeed: t( "Shutter-speed" ),
    iso: t( "ISO" ),
    focusDistance: t( "Focus-distance" ),
  };

  if ( photoCount === 0 ) {
    return (
      <View className="flex-1 justify-center items-center p-5">
        <Body2 className="text-center">{t( "No-camera-settings-for-these-photos" )}</Body2>
      </View>
    );
  }

  return (
    <ScrollView contentContainerClassName="px-5 pb-10" testID="ExploreCameraStats">
      <Body3 className="mb-4">
        {t( "Camera-settings-of-X-photos-added-on-this-device", { count: photoCount } )}
      </Body3>
      {distributions.filter( ( { rows } ) => rows.length > 0 ).map( ( { field, rows } ) => {
        const max = Math.max( ...rows.map( ( [, count] ) => count ) );
        return (
          <View key={field} className="mb-6">
            <Heading4 className="mb-2">{labels[field]}</Heading4>
            {rows.map( ( [value, count] ) => (
              <View key={value} className="flex-row items-center mb-1">
                <Body4 className="w-2/5 pr-2" numberOfLines={1}>{value}</Body4>
                <View className="flex-1 flex-row items-center">
                  <View
                    className="h-3 rounded-sm bg-inatGreen mr-2"
                    style={{ width: `${( count / max ) * 85}%` }}
                  />
                  <Body4>{count}</Body4>
                </View>
              </View>
            ) )}
          </View>
        );
      } )}
    </ScrollView>
  );
};

export default CameraStatsView;
