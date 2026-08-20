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
  // The same photo is framed under whichever size variant the screen happens to
  // display (the media viewer saves the original URL, Suggestions looks the
  // medium one up), and the crop is normalized so it means the same thing at
  // every size. Key on the large URL both ways so a framing saved on one screen
  // is found on the next.
  normalizeKeyOnSave: true,
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

// Notified whenever any crop is saved or removed, so screens showing a framed
// photo can pick up a framing the user just made somewhere else (e.g. pinching
// in the media viewer opened from the Add an ID screen).
export const subscribeAnimalCropLog = (
  listener: ( ) => void,
): ( ) => void => animalCropLog.subscribe( listener );
