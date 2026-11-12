import {
  ActivityIndicator,
  Body1,
  Body3,
  Body4,
  Heading4,
  ScrollViewWrapper,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { TFunction } from "i18next";
import React, { useEffect, useState } from "react";
import type { StorageBreakdown, StorageCategory } from "sharedHelpers/storageBreakdown";
import getStorageBreakdown from "sharedHelpers/storageBreakdown";
import { useTranslation } from "sharedHooks";

const categoryText = ( t: TFunction ): Record<StorageCategory, [string, string]> => ( {
  photos: [t( "Observation-photos--storage" ), t( "Observation-photos--storage-description" )],
  sounds: [t( "Observation-sounds--storage" ), t( "Observation-sounds--storage-description" )],
  videos: [t( "Videos--storage" ), t( "Videos--storage-description" )],
  usbImports: [t( "USB-imports--storage" ), t( "USB-imports--storage-description" )],
  audioId: [t( "Audio-ID-clips--storage" ), t( "Audio-ID-clips--storage-description" )],
  offlineExplore: [
    t( "Offline-Explore--storage" ),
    t( "Offline-Explore--storage-description" ),
  ],
  database: [t( "Database--storage" ), t( "Database--storage-description" )],
  appSettings: [t( "App-settings--storage" ), t( "App-settings--storage-description" )],
  temporaryPhotos: [
    t( "Temporary-photos--storage" ),
    t( "Temporary-photos--storage-description" ),
  ],
  aiModels: [t( "AI-models--storage" ), t( "AI-models--storage-description" )],
  cache: [t( "Cache--storage" ), t( "Cache--storage-description" )],
  app: [t( "App--storage" ), t( "App--storage-description" )],
  other: [t( "Other--storage" ), t( "Other--storage-description" )],
} );

// One fixed color per category, so a category keeps its color between visits
const CATEGORY_COLORS: Record<StorageCategory, string> = {
  photos: "#74AC00",
  sounds: "#1F77B4",
  videos: "#9467BD",
  usbImports: "#8C564B",
  audioId: "#17BECF",
  offlineExplore: "#2CA02C",
  database: "#FF7F0E",
  appSettings: "#BCBD22",
  temporaryPhotos: "#E377C2",
  aiModels: "#D62728",
  cache: "#7F7F7F",
  app: "#3A5600",
  other: "#BFBFBF",
};

// Every amount in GB with two decimals, so sizes line up and compare at a glance
export const formatGB = ( bytes: number ) => `${( bytes / 1073741824 ).toFixed( 2 )} GB`;

// How much space the app takes on this device, by what it's for
const StorageUsage = ( ) => {
  const { t } = useTranslation( );
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>( null );
  const [failed, setFailed] = useState( false );

  useEffect( ( ) => {
    let cancelled = false;
    getStorageBreakdown( )
      .then( result => { if ( !cancelled ) setBreakdown( result ); } )
      .catch( ( ) => { if ( !cancelled ) setFailed( true ); } );
    return ( ) => { cancelled = true; };
  }, [] );

  if ( failed ) {
    return (
      <View className="p-4">
        <Body1>{t( "Storage-usage-could-not-be-measured" )}</Body1>
      </View>
    );
  }

  if ( !breakdown ) {
    return (
      <View className="flex-1 items-center justify-center p-4">
        <ActivityIndicator size={50} />
        <Body3 className="mt-4">{t( "Measuring-storage" )}</Body3>
      </View>
    );
  }

  const text = categoryText( t );
  const shareOf = ( bytes: number ) => ( breakdown.totalBytes > 0
    ? ( bytes / breakdown.totalBytes ) * 100
    : 0 );

  return (
    <ScrollViewWrapper>
      <View className="p-4">
        <Heading4>{t( "TOTAL-STORAGE-USED" )}</Heading4>
        <Body1 className="mt-2" testID="StorageUsage.total">
          {formatGB( breakdown.totalBytes )}
        </Body1>
        <View
          className="flex-row h-6 mt-4 rounded-lg bg-lightGray overflow-hidden"
          testID="StorageUsage.bar"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {breakdown.categories.map( ( { category, bytes } ) => (
            <View
              key={category}
              className="basis-0 min-w-[2px]"
              style={{ flexGrow: bytes, backgroundColor: CATEGORY_COLORS[category] }}
            />
          ) )}
        </View>
        <Heading4 className="mt-[30px] mb-[15px]">{t( "BREAKDOWN--storage" )}</Heading4>
        {breakdown.categories.map( ( { category, bytes } ) => {
          const [label, description] = text[category];
          const size = formatGB( bytes );
          return (
            <View
              key={category}
              className="flex-row mb-5"
              accessible
              accessibilityLabel={`${label}, ${size}`}
            >
              <View
                className="w-4 h-4 mt-1 mr-3 rounded-sm"
                style={{ backgroundColor: CATEGORY_COLORS[category] }}
              />
              <View className="flex-1">
                <View className="flex-row justify-between">
                  <Body1 className="shrink">{label}</Body1>
                  <Body1 className="ml-2">{size}</Body1>
                </View>
                <View className="flex-row justify-between mt-1">
                  <Body4 className="shrink">{description}</Body4>
                  <Body4 className="ml-2">{`${Math.round( shareOf( bytes ) )}%`}</Body4>
                </View>
              </View>
            </View>
          );
        } )}
      </View>
    </ScrollViewWrapper>
  );
};

export default StorageUsage;
