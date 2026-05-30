import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import type { Asset } from "react-native-image-picker";

export interface LibraryPhoto {
  asset: Asset;
  deviceUri: string | null;
  id: string;
  isVideo: boolean;
  photo: PhotoIdentifier;
  timestampMs: number;
}

export interface PhotoLibraryDateHeaderItem {
  dateKey: string;
  title: string;
  type: "header";
}

export interface PhotoLibraryRowItem {
  photos: LibraryPhoto[];
  type: "row";
}

export type PhotoLibraryListItem = PhotoLibraryDateHeaderItem | PhotoLibraryRowItem;

export const isPhotoLibraryHeader = (
  item: PhotoLibraryListItem,
): item is PhotoLibraryDateHeaderItem => item.type === "header";

export const isPhotoLibraryRow = (
  item: PhotoLibraryListItem,
): item is PhotoLibraryRowItem => item.type === "row";
