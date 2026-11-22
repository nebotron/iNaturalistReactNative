import { CachesDirectoryPath, DocumentDirectoryPath } from "@dr.pogodin/react-native-fs";

export const computerVisionPath = `${DocumentDirectoryPath}/computerVisionSuggestions`;

// note: when changing naming from gallery to photoLibrary in issue MOB-431,
// this galleryPhotos path was intentionally left as-is, to avoid any issues
// with cleaning caches
export const photoLibraryPhotosPath = `${DocumentDirectoryPath}/galleryPhotos`;

export const photoUploadPath = `${DocumentDirectoryPath}/photoUploads`;

export const rotatedOriginalPhotosPath = `${DocumentDirectoryPath}/rotatedOriginalPhotos`;

export const sentinelFilePath = `${DocumentDirectoryPath}/sentinelFiles`;

export const soundUploadPath = `${DocumentDirectoryPath}/soundUploads`;

export const rollbackPhotosPath = `${DocumentDirectoryPath}/rollbackPhotos`;

// Originals copied off a USB drive, kept until faved or expired (usbStaging.ts)
export const usbStagingPath = `${DocumentDirectoryPath}/usbStaging`;

// Staged USB photos whose retention clock is running, which iOS may purge when
// the device runs low on space. The folder keeps the name "usbStaging" because
// photos are matched to observations by their "/usbStaging/<name>" path.
export const purgeableUsbStagingPath = `${CachesDirectoryPath}/usbStaging`;

export const videoLibraryPath = `${DocumentDirectoryPath}/videoLibrary`;

export const cropSourcesPath = `${CachesDirectoryPath}/inatCropSources`;

export const brightnessAdjustedPath = `${CachesDirectoryPath}/inatBrightnessAdjusted`;

export const deviceThumbnailsPath = `${CachesDirectoryPath}/inatDeviceThumbnails`;

// faster-image's (Nuke's) disk cache of remote images.
export const remoteImageCachePath = `${CachesDirectoryPath}/com.github.kean.Nuke.DataCache`;
