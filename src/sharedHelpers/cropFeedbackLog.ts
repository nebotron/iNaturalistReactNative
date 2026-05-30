import Clipboard from "@react-native-clipboard/clipboard";
import { Alert } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { cropOriginalUriFromPath } from "sharedHelpers/cropPhotoMetadata";
import { zustandStorage } from "stores/useStore";

const CROP_FEEDBACK_STORAGE_KEY = "cropFeedbackLog";

export interface CropFeedbackEntry {
  sourceKey: string;
  uploadedUrl: string | null;
  crop: NormalizedCrop | null;
  kept: boolean;
  recordedAt: string;
}

type StoredCropFeedback = Record<string, CropFeedbackEntry>;

const loadCropFeedback = ( ): StoredCropFeedback => {
  const raw = zustandStorage.getItem( CROP_FEEDBACK_STORAGE_KEY );
  if ( !raw || typeof raw !== "string" ) {
    return {};
  }
  try {
    return JSON.parse( raw ) as StoredCropFeedback;
  } catch {
    return {};
  }
};

const saveCropFeedback = ( data: StoredCropFeedback ) => {
  zustandStorage.setItem( CROP_FEEDBACK_STORAGE_KEY, JSON.stringify( data ) );
};

export const recordCropFeedback = (
  sourceKey: string,
  update: {
    crop: NormalizedCrop | null;
    kept: boolean;
  },
) => {
  if ( !sourceKey ) {
    return;
  }

  const data = loadCropFeedback( );
  data[sourceKey] = {
    sourceKey,
    uploadedUrl: data[sourceKey]?.uploadedUrl ?? null,
    crop: update.crop,
    kept: update.kept,
    recordedAt: new Date().toISOString( ),
  };
  saveCropFeedback( data );
};

const normalizeSourceKey = ( key: string ) => key.replace( /^file:\/\//, "" );

const findCropFeedbackKey = (
  data: StoredCropFeedback,
  candidate: string,
): string | undefined => {
  if ( data[candidate] ) {
    return candidate;
  }

  const normalizedCandidate = normalizeSourceKey( candidate );
  return Object.keys( data ).find( key => (
    key === candidate
    || normalizeSourceKey( key ) === normalizedCandidate
    || key.includes( normalizedCandidate )
    || normalizedCandidate.includes( normalizeSourceKey( key ) )
  ) );
};

export const linkCropFeedbackUploadedUrl = (
  sourceKey: string,
  uploadedUrl: string,
) => {
  if ( !sourceKey || !uploadedUrl ) {
    return;
  }

  const data = loadCropFeedback( );
  const existingKey = findCropFeedbackKey( data, sourceKey );
  if ( !existingKey ) {
    return;
  }

  data[existingKey] = {
    ...data[existingKey],
    uploadedUrl,
  };
  saveCropFeedback( data );
};

export const linkCropFeedbackUploadedUrlForPhoto = (
  photo: {
    cropOriginalLocalFilePath?: string | null;
    localFilePath?: string | null;
  },
  uploadedUrl: string,
) => {
  const cropOriginalUri = cropOriginalUriFromPath( photo.cropOriginalLocalFilePath );
  if ( cropOriginalUri ) {
    linkCropFeedbackUploadedUrl( cropOriginalUri, uploadedUrl );
  }
  if ( photo.localFilePath ) {
    linkCropFeedbackUploadedUrl( cropOriginalUriFromPath( photo.localFilePath ) || photo.localFilePath, uploadedUrl );
  }
};

export const getCropFeedbackExportObject = ( ): Record<string, {
  crop: NormalizedCrop | null;
  kept: boolean;
}> => {
  const data = loadCropFeedback( );
  return Object.values( data ).reduce( ( exportObject, entry ) => {
    const key = entry.uploadedUrl || entry.sourceKey;
    exportObject[key] = {
      crop: entry.crop,
      kept: entry.kept,
    };
    return exportObject;
  }, {} as Record<string, { crop: NormalizedCrop | null; kept: boolean }> );
};

export const copyCropFeedbackToClipboard = ( ) => {
  const exportObject = getCropFeedbackExportObject( );
  const json = JSON.stringify( exportObject, null, 2 );
  Clipboard.setString( json );
  Alert.alert(
    "Copied crop feedback",
    `${Object.keys( exportObject ).length} entries copied to the clipboard as JSON.`,
  );
};
