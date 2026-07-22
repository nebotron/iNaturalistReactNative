import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { createUrlKeyedFirebaseLog } from "sharedHelpers/urlKeyedFirebaseLog";

export type AnimalCropLog = Record<string, NormalizedCrop>;

interface CropLogEntry {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Only remote photo URLs are worth syncing: local `file://`/`ph://` paths are
// ephemeral (they point at one device's temporary upload dir, so the offline
// training scripts can never fetch them) and, being long, their encoded keys
// overflow Firebase's 768-byte key limit and fail the PUT with HTTP 400.
const animalCropLog = createUrlKeyedFirebaseLog<NormalizedCrop>( {
  storageKey: "animalCropLog",
  firebasePath: "crop_log",
  shouldSync: url => url.startsWith( "http" ),
  toFirebaseEntry: ( url, crop ) => ( {
    url, x: crop.x, y: crop.y, w: crop.w, h: crop.h,
  } ),
} );

// Viewers show the local log, which contains everything this device labeled.
export const getAnimalCropLogAsArray = ( ): CropLogEntry[] => Object
  .entries( animalCropLog.load( ) )
  .filter( ( [url] ) => url.startsWith( "http" ) )
  .map( ( [url, crop] ) => ( {
    url, x: crop.x, y: crop.y, w: crop.w, h: crop.h,
  } ) )
  .reverse( );

export const saveAnimalCrop = ( photoUrl: string, crop: NormalizedCrop ) => {
  animalCropLog.save( photoUrl, crop );
};

export const deleteAnimalCrop = ( photoUrl: string ) => animalCropLog.remove( photoUrl );

export const getAnimalCrop = ( url: string ): NormalizedCrop | null => animalCropLog.get( url );
