import { formatSizeUnits } from "components/Developer/hooks/useAppSize";
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
  const largest = breakdown.categories[0]?.bytes || 1;

  return (
    <ScrollViewWrapper>
      <View className="p-4">
        <Heading4>{t( "TOTAL-STORAGE-USED" )}</Heading4>
        <Body1 className="mt-2" testID="StorageUsage.total">
          {formatSizeUnits( breakdown.totalBytes )}
        </Body1>
        {breakdown.freeDiskBytes >= 0 && (
          <Body3 className="mt-1">
            {t( "Storage-free-on-device", {
              size: formatSizeUnits( breakdown.freeDiskBytes ),
            } )}
          </Body3>
        )}
        <Heading4 className="mt-[30px] mb-[15px]">{t( "BREAKDOWN--storage" )}</Heading4>
        {breakdown.categories.map( ( { category, bytes } ) => {
          const [label, description] = text[category];
          const share = breakdown.totalBytes > 0
            ? Math.round( ( bytes / breakdown.totalBytes ) * 100 )
            : 0;
          return (
            <View
              key={category}
              className="mb-5"
              accessible
              accessibilityLabel={`${label}, ${formatSizeUnits( bytes )}`}
            >
              <View className="flex-row justify-between">
                <Body1 className="shrink">{label}</Body1>
                <Body1 className="ml-2">{formatSizeUnits( bytes )}</Body1>
              </View>
              <View className="h-2 mt-1 rounded-full bg-lightGray overflow-hidden">
                <View
                  className="h-2 rounded-full bg-inatGreen"
                  style={{ width: `${Math.max( ( bytes / largest ) * 100, 1 )}%` }}
                />
              </View>
              <View className="flex-row justify-between mt-1">
                <Body4 className="shrink">{description}</Body4>
                <Body4 className="ml-2">{`${share}%`}</Body4>
              </View>
            </View>
          );
        } )}
      </View>
    </ScrollViewWrapper>
  );
};

export default StorageUsage;
