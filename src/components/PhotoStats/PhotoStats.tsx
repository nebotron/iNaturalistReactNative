/* eslint-disable i18next/no-literal-string */
import { ActivityIndicator, Body2, Heading4 } from "components/SharedComponents";
import { ScrollView, Text, View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useState } from "react";
import type { RealmObservation, RealmPhoto } from "realmModels/types";
import type { PhotoMetadata } from "sharedHelpers/readPhotoExif";
import readPhotoExif from "sharedHelpers/readPhotoExif";
import colors from "styles/tailwindColors";

const { useRealm } = RealmContext;

type Counts = Record<string, number>;

interface Stats {
  total: number;
  withExif: number;
  focal: Counts;
  effectiveFocal: Counts;
  cameras: Counts;
  lenses: Counts;
  crop: Counts;
}

const FOCAL_BINS: [number, string][] = [
  [20, "< 20 mm"],
  [35, "20–34 mm"],
  [70, "35–69 mm"],
  [135, "70–134 mm"],
  [300, "135–299 mm"],
  [600, "300–599 mm"],
  [1000, "600–999 mm"],
  [Infinity, "≥ 1000 mm"],
];

// Fraction of the original area kept
const CROP_BINS: [number, string][] = [
  [0.1, "< 10% kept"],
  [0.25, "10–24% kept"],
  [0.5, "25–49% kept"],
  [0.75, "50–74% kept"],
  [1, "75–99% kept"],
  [Infinity, "Uncropped"],
];

const bin = ( value: number, bins: [number, string][] ) => (
  bins.find( ( [max] ) => value < max ) || bins[bins.length - 1]
)[1];

const emptyCounts = ( bins: [number, string][] ) => Object.fromEntries(
  bins.map( ( [, label] ) => [label, 0] ),
);

const increment = ( counts: Counts, key: string ) => {
  counts[key] = ( counts[key] || 0 ) + 1;
};

const str = ( value: unknown ) => String( value ?? "" ).replace( /\0/g, "" ).trim( );

const cameraName = ( tags: PhotoMetadata ) => {
  const make = str( tags.Make );
  const model = str( tags.Model );
  if ( !model ) return make;
  return model.toLowerCase( ).startsWith( make.split( " " )[0].toLowerCase( ) )
    ? model
    : `${make} ${model}`.trim( );
};

// 35mm-equivalent focal length when the camera records it, else the actual one
const equivalentFocalLength = ( tags: PhotoMetadata ) => {
  const eq = Number( tags.FocalLenIn35mmFilm ?? tags.FocalLengthIn35mmFilm );
  if ( Number.isFinite( eq ) && eq > 0 ) return eq;
  const actual = Number( tags.FocalLength );
  return Number.isFinite( actual ) && actual > 0
    ? actual
    : null;
};

const cropArea = ( photo: RealmPhoto ) => (
  photo.cropW != null && photo.cropH != null
    ? Math.min( photo.cropW * photo.cropH, 1 )
    : 1
);

// Prefer the uncropped original, which keeps the camera's full EXIF. Local
// files only: remote copies are largely stripped and slow to fetch.
const readLocalExif = ( photo: RealmPhoto ) => {
  const localFilePath = photo.cropOriginalLocalFilePath || photo.localFilePath;
  return localFilePath
    ? readPhotoExif( { localFilePath } )
    : Promise.resolve( null );
};

const BarChart = ( { title, counts }: { title: string; counts: Counts } ) => {
  const entries = Object.entries( counts ).filter( ( [, n] ) => n > 0 );
  const max = Math.max( ...entries.map( ( [, n] ) => n ), 1 );
  return (
    <View className="px-5 pt-5">
      <Heading4 className="mb-2">{title}</Heading4>
      {entries.length === 0 && <Body2>No data</Body2>}
      {entries.map( ( [label, n] ) => (
        <View key={label} className="flex-row items-center py-1">
          <Text className="w-2/5 pr-2" numberOfLines={2}>{label}</Text>
          <View className="flex-1 flex-row items-center">
            <View
              className="h-4 rounded-sm"
              style={{
                width: `${( n / max ) * 80}%`,
                backgroundColor: colors.inatGreen,
              }}
            />
            <Text className="ml-2">{n}</Text>
          </View>
        </View>
      ) )}
    </View>
  );
};

const sortedByCount = ( counts: Counts ) => Object.fromEntries(
  Object.entries( counts ).sort( ( a, b ) => b[1] - a[1] ),
);

const PhotoStats = ( ) => {
  const realm = useRealm( );
  const [stats, setStats] = useState<Stats | null>( null );
  const [progress, setProgress] = useState( 0 );

  useEffect( ( ) => {
    let cancelled = false;
    const seen = new Set<string>( );
    const photos: RealmPhoto[] = [];
    realm.objects<RealmObservation>( "Observation" ).forEach( obs => {
      obs.observationPhotos?.forEach( obsPhoto => {
        const { photo } = obsPhoto;
        const key = photo?.localFilePath || photo?.url;
        if ( !photo || !key || seen.has( key ) ) return;
        seen.add( key );
        photos.push( photo );
      } );
    } );

    ( async ( ) => {
      const result: Stats = {
        total: photos.length,
        withExif: 0,
        focal: emptyCounts( FOCAL_BINS ),
        effectiveFocal: emptyCounts( FOCAL_BINS ),
        cameras: {},
        lenses: {},
        crop: emptyCounts( CROP_BINS ),
      };
      for ( let i = 0; i < photos.length; i += 1 ) {
        if ( cancelled ) return;
        const photo = photos[i];
        const area = cropArea( photo );
        increment( result.crop, bin( area, CROP_BINS ) );
        // eslint-disable-next-line no-await-in-loop
        const tags = await readLocalExif( photo ).catch( ( ) => null );
        if ( tags ) {
          const camera = cameraName( tags );
          const lens = str( tags.LensModel );
          const focal = equivalentFocalLength( tags );
          if ( camera || lens || focal ) result.withExif += 1;
          if ( camera ) increment( result.cameras, camera );
          if ( lens ) increment( result.lenses, lens );
          if ( focal ) {
            increment( result.focal, bin( focal, FOCAL_BINS ) );
            // Cropping magnifies like a longer lens, by the linear crop factor
            increment( result.effectiveFocal, bin( focal / Math.sqrt( area ), FOCAL_BINS ) );
          }
        }
        if ( i % 20 === 0 ) setProgress( i );
      }
      if ( !cancelled ) setStats( result );
    } )( );

    return ( ) => { cancelled = true; };
  }, [realm] );

  if ( !stats ) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator />
        <Body2 className="mt-3">{`Reading photo metadata… ${progress}`}</Body2>
      </View>
    );
  }

  return (
    <ScrollView className="bg-white">
      <Body2 className="px-5 pt-5">
        {`${stats.total} photos, ${stats.withExif} with camera metadata on this device`}
      </Body2>
      <BarChart title="Focal length (35mm equiv.)" counts={stats.focal} />
      <BarChart title="Effective focal length incl. crop" counts={stats.effectiveFocal} />
      <BarChart title="Cropping" counts={stats.crop} />
      <BarChart title="Camera" counts={sortedByCount( stats.cameras )} />
      <BarChart title="Lens" counts={sortedByCount( stats.lenses )} />
      <View className="h-10" />
    </ScrollView>
  );
};

export default PhotoStats;
