import { Platform } from "react-native";
import type { Asset } from "react-native-image-picker";

export const normalizeDevicePhotoUri = ( uri: string | null | undefined ): string | null => {
  if ( !uri ) {
    return null;
  }
  const trimmedUri = uri.trim( );
  if ( trimmedUri.startsWith( "ph://" ) ) {
    return trimmedUri;
  }
  if (
    trimmedUri.startsWith( "file://" )
    || trimmedUri.startsWith( "content://" )
  ) {
    return trimmedUri;
  }
  return `ph://${trimmedUri}`;
};

export const getGalleryAssetDevicePhotoUri = ( asset: Asset ): string | null => {
  if ( asset.type?.startsWith( "video/" ) ) {
    return null;
  }
  if ( asset.originalPath ) {
    return normalizeDevicePhotoUri( asset.originalPath );
  }
  if ( Platform.OS === "ios" && asset.id ) {
    return normalizeDevicePhotoUri( `ph://${asset.id}` );
  }
  const uri = asset.uri ?? null;
  if ( !uri ) {
    return null;
  }
  const normalizedUri = normalizeDevicePhotoUri( uri );
  if (
    normalizedUri.startsWith( "file://" )
    || ( Platform.OS === "ios" && !normalizedUri.startsWith( "ph://" ) )
  ) {
    return null;
  }
  return normalizedUri;
};

export const getOriginalDevicePhotoUri = ( asset: Asset ): string | null => {
  if ( asset.type?.startsWith( "video/" ) ) {
    return null;
  }
  const galleryUri = getGalleryAssetDevicePhotoUri( asset );
  if ( galleryUri ) {
    return galleryUri;
  }
  const uri = asset.uri ?? null;
  return uri
    ? normalizeDevicePhotoUri( uri )
    : null;
};

export const getOriginalDevicePhotoUrisFromAssets = ( assets: Asset[] ): string[] => {
  const uris = assets
    .map( getGalleryAssetDevicePhotoUri )
    .filter( ( uri ): uri is string => !!uri );
  return [...new Set( uris )];
};

export const registerImportedPhotoDeviceUriMappings = (
  mappings: Record<string, string>,
  localUri: string,
  deviceUri: string | null | undefined,
): void => {
  const normalizedDeviceUri = normalizeDevicePhotoUri( deviceUri );
  if ( !normalizedDeviceUri || !localUri ) {
    return;
  }
  mappings[localUri] = normalizedDeviceUri;
  if ( localUri.startsWith( "file://" ) ) {
    mappings[localUri.replace( "file://", "" )] = normalizedDeviceUri;
  } else {
    mappings[`file://${localUri}`] = normalizedDeviceUri;
  }
};

export const lookupImportedPhotoDeviceUri = (
  mappings: Record<string, string>,
  localUri: string | null | undefined,
): string | null => {
  if ( !localUri ) {
    return null;
  }
  return normalizeDevicePhotoUri( mappings[localUri] );
};
