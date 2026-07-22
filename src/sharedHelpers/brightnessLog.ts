import { createUrlKeyedFirebaseLog } from "sharedHelpers/urlKeyedFirebaseLog";

export type BrightnessLog = Record<string, number>;

// Skip local paths (ephemeral, unfetchable by the offline scripts) and
// static.inaturalist.org placeholders — neither is worth syncing.
const brightnessLog = createUrlKeyedFirebaseLog<number>( {
  storageKey: "brightnessLog",
  firebasePath: "brightness_log",
  normalizeKeyOnSave: true,
  shouldSync: url => url.startsWith( "http" ) && !url.includes( "static.inaturalist.org" ),
  toFirebaseEntry: ( url, brightness ) => ( { url, brightness } ),
} );

export const subscribeToBrightnessLog = brightnessLog.subscribe;

// brightness is the ideal multiplier (1.0 = no change).
export const saveBrightness = ( photoUrl: string, brightness: number ): Promise<void> => (
  brightnessLog.save( photoUrl, brightness )
);

export const deleteBrightness = ( photoUrl: string ) => brightnessLog.remove( photoUrl );

export const getBrightness = ( url: string ): number | null => brightnessLog.get( url );
