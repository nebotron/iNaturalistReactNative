import type { ExifTags } from "@lodev09/react-native-exify";
import {
  ActivityIndicator,
  BottomSheet,
} from "components/SharedComponents";
import { Text, View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import readPhotoExif from "sharedHelpers/readPhotoExif";
import useTranslation from "sharedHooks/useTranslation";

interface PhotoLike {
  localFilePath?: string;
  url?: string;
}

interface Props {
  photo: PhotoLike;
  onClose: ( ) => void;
  insideModal?: boolean;
}

// Tags most useful for understanding capture conditions, shown first and in
// this order. SubjectDistance is the focus/subject distance cameras such as the
// Canon R7 record for each frame.
const PRIORITY_TAGS = [
  "Make",
  "Model",
  "LensMake",
  "LensModel",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "SubjectDistance",
  "SubjectDistanceRange",
  "FNumber",
  "ApertureValue",
  "ExposureTime",
  "ShutterSpeedValue",
  "ISOSpeedRatings",
  "ExposureBiasValue",
  "Flash",
  "DateTimeOriginal",
];

const MAX_VALUE_LENGTH = 200;

const formatValue = ( value: unknown ): string => {
  if ( value === null || value === undefined ) return "";
  let str: string;
  if ( Array.isArray( value ) ) {
    str = value.join( ", " );
  } else if ( typeof value === "object" ) {
    str = JSON.stringify( value );
  } else {
    str = String( value );
  }
  return str.length > MAX_VALUE_LENGTH
    ? `${str.slice( 0, MAX_VALUE_LENGTH )}…`
    : str;
};

// Order tags with the priority list first (in its defined order), then all
// remaining tags alphabetically.
const orderedEntries = ( tags: ExifTags ): [string, unknown][] => {
  const keys = Object.keys( tags ).filter(
    key => tags[key as keyof ExifTags] !== undefined
      && tags[key as keyof ExifTags] !== null
      && tags[key as keyof ExifTags] !== "",
  );
  const priority = PRIORITY_TAGS.filter( key => keys.includes( key ) );
  const rest = keys
    .filter( key => !PRIORITY_TAGS.includes( key ) )
    .sort( ( a, b ) => a.localeCompare( b ) );
  return [...priority, ...rest].map(
    key => [key, tags[key as keyof ExifTags]] as [string, unknown],
  );
};

const MetadataSheet = ( { photo, onClose, insideModal }: Props ) => {
  const { t } = useTranslation( );
  const [tags, setTags] = useState<ExifTags | null>( null );
  const [loading, setLoading] = useState( true );

  useEffect( ( ) => {
    let active = true;
    setLoading( true );
    readPhotoExif( photo ).then( result => {
      if ( !active ) return;
      setTags( result );
      setLoading( false );
    } );
    return ( ) => {
      active = false;
    };
  }, [photo] );

  const entries = tags
    ? orderedEntries( tags )
    : [];

  const renderBody = ( ) => {
    if ( loading ) {
      return (
        <View className="py-8 items-center">
          <ActivityIndicator />
        </View>
      );
    }
    if ( entries.length === 0 ) {
      return (
        <Text className="text-center py-4">
          {t( "No-metadata-available" )}
        </Text>
      );
    }
    return entries.map( ( [key, value], index ) => (
      <View
        key={key}
        className={`flex-row py-2 ${
          index === 0
            ? ""
            : "border-t border-lightGray"
        }`}
      >
        <Text className="w-1/2 pr-2 font-bold">{key}</Text>
        <Text className="w-1/2" selectable>{formatValue( value )}</Text>
      </View>
    ) );
  };

  return (
    <BottomSheet
      onPressClose={onClose}
      headerText={t( "Photo-metadata" )}
      insideModal={insideModal}
      testID="MediaViewer.MetadataSheet"
    >
      <View className="p-5">
        {renderBody( )}
      </View>
    </BottomSheet>
  );
};

export default MetadataSheet;
