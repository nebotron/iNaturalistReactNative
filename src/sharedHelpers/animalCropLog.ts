import Clipboard from "@react-native-clipboard/clipboard";
import { Alert } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { zustandStorage } from "stores/useStore";

const ANIMAL_CROP_LOG_KEY = "animalCropLog";

export type AnimalCropLog = Record<string, NormalizedCrop>;

const load = ( ): AnimalCropLog => {
  const raw = zustandStorage.getItem( ANIMAL_CROP_LOG_KEY );
  if ( !raw || typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as AnimalCropLog;
  } catch {
    return {};
  }
};

export const saveAnimalCrop = ( photoUrl: string, crop: NormalizedCrop ) => {
  const log = load( );
  log[photoUrl] = crop;
  zustandStorage.setItem( ANIMAL_CROP_LOG_KEY, JSON.stringify( log ) );
};

export const getAnimalCropCount = ( ): number => Object.keys( load( ) ).length;

export const copyAnimalCropLogToClipboard = ( ) => {
  const log = load( );
  const count = Object.keys( log ).length;
  Clipboard.setString( JSON.stringify( log, null, 2 ) );
  Alert.alert( "Copied", `${count} crops copied to clipboard.` );
};
