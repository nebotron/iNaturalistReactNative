import { MMKV } from "react-native-mmkv";

// Hard-coded constants the user can override from Settings > Tunable
// Parameters. Values are read once when the module that uses them loads, so
// overrides take effect after the app restarts. Kept in their own MMKV
// instance so signing out (which clears the main store) doesn't reset them.

export type TunableSection =
  | "ai"
  | "audio"
  | "camera"
  | "location"
  | "uploads"
  | "storage"
  | "usb"
  | "explore"
  | "game"
  | "interface";

interface TunableDefinition {
  section: TunableSection;
  default: number;
  min: number;
  max: number;
  integer?: boolean;
}

const def = (
  section: TunableSection,
  defaultValue: number,
  min: number,
  max: number,
  integer = true,
): TunableDefinition => ( {
  section, default: defaultValue, min, max, integer,
} );

export const TUNABLE_PARAMS = {
  aiCameraFps: def( "ai", 1, 0.2, 10, false ),
  aiCameraConfidenceThreshold: def( "ai", 70, 0, 100 ),
  aiCameraStoredResults: def( "ai", 5, 1, 20 ),
  aiCameraCropRatio: def( "ai", 1, 0.1, 1, false ),
  topSuggestionScoreThreshold: def( "ai", 78, 0, 100 ),
  matchHighConfidence: def( "ai", 93, 0, 100 ),
  matchLikelyConfidence: def( "ai", 50, 0, 100 ),
  onlineSuggestionsTimeoutSeconds: def( "ai", 5, 1, 60 ),
  subjectCropPadding: def( "ai", 0.1, 0, 1, false ),
  subjectCropFrameFraction: def( "ai", 0.8, 0.1, 1, false ),

  audioIdThreshold: def( "audio", 0.6, 0, 1, false ),
  audioIdAlsoHeard: def( "audio", 0.7, 0, 1, false ),
  audioIdDimAfterSeconds: def( "audio", 30, 1, 600 ),
  audioIdFlashSeconds: def( "audio", 3, 1, 60 ),
  audioIdNewCallGapSeconds: def( "audio", 3, 0.5, 60, false ),
  audioIdRealertHours: def( "audio", 24, 0.1, 720, false ),
  audioIdRecentObsDays: def( "audio", 30, 0, 365 ),
  audioIdBirdGeoThreshold: def( "audio", 0.03, 0, 1, false ),
  audioIdNonBirdGeoThreshold: def( "audio", 0.0003, 0, 1, false ),

  maxPhotosPerObservation: def( "camera", 20, 1, 100 ),
  maxSoundsPerObservation: def( "camera", 20, 1, 100 ),
  maxCameraZoom: def( "camera", 20, 1, 100 ),
  minFreeStorageMb: def( "camera", 200, 0, 10000 ),
  maxPhotoInspectZoom: def( "camera", 20, 2, 100 ),

  targetLocationAccuracyM: def( "location", 10, 1, 1000 ),
  locationAccuracyDeadlineSeconds: def( "location", 6, 1, 60 ),
  desiredLocationAccuracyM: def( "location", 100, 1, 10000 ),
  locationHistoryDistanceM: def( "location", 50, 1, 10000 ),
  locationHistoryIntervalMinutes: def( "location", 2, 0.1, 60, false ),
  locationMatchMaxGapHours: def( "location", 12, 0.1, 168, false ),
  locationHistoryMaxAccuracyM: def( "location", 100, 1, 10000 ),
  defaultObsLocationAccuracyM: def( "location", 1000, 1, 100000 ),

  maxConcurrentUploads: def( "uploads", 3, 1, 10 ),
  uploadMaxDimension: def( "uploads", 2048, 512, 4096 ),
  uploadMaxMb: def( "uploads", 5, 1, 50 ),
  uploadMaxRetries: def( "uploads", 3, 0, 10 ),
  uploadTimeoutMinutes: def( "uploads", 5, 1, 60 ),
  importSectionGapMinutes: def( "uploads", 5, 0.1, 1440, false ),
  importMaxSectionSize: def( "uploads", 100, 2, 1000 ),

  cropCacheDays: def( "storage", 2, 0.1, 60, false ),
  remoteImageCacheMb: def( "storage", 500, 10, 10000 ),
  cropSourcesCacheMb: def( "storage", 1024, 10, 20000 ),
  syncedPhotoFolderMaxGb: def( "storage", 5, 0.1, 100, false ),
  maxOfflineObservations: def( "storage", 5000, 100, 50000 ),
  offlineMaxTileZoom: def( "storage", 18, 1, 21 ),
  offlineMaxMapPins: def( "storage", 1000, 10, 10000 ),

  usbMaxPhotosPerScan: def( "usb", 500, 1, 5000 ),

  ebirdMaxDistKm: def( "explore", 50, 1, 50 ),
  ebirdBackDays: def( "explore", 30, 1, 30 ),
  ebirdMaxResults: def( "explore", 100, 1, 1000 ),
  ebirdCollapsedCount: def( "explore", 3, 1, 50 ),
  hotspotClusterRadiusKm: def( "explore", 1.5, 0.1, 50, false ),
  hotspotParkingMinutes: def( "explore", 5, 0, 60 ),
  hotspotRoutePaddingKm: def( "explore", 80, 1, 500 ),
  hotspotRecentAddresses: def( "explore", 10, 0, 100 ),
  hotspotTimeStepMinutes: def( "explore", 15, 1, 120 ),
  hotspotMaxPlanCandidates: def( "explore", 40, 1, 200 ),
  placeSearchMaxSuggestions: def( "explore", 5, 1, 20 ),

  gamePoolSize: def( "game", 20, 1, 200 ),
  gameLookalikeRadiusKm: def( "game", 500, 1, 20000 ),
  gameLocationRadiusKm: def( "game", 200, 1, 20000 ),

  toastDurationSeconds: def( "interface", 2, 0.5, 30, false ),
  minSmallGridColumns: def( "interface", 3, 1, 10 ),
  advancedModeOnboardingObservations: def( "interface", 100, 0, 100000 ),
  autoAdvancedModeObservations: def( "interface", 100, 0, 100000 ),
} satisfies Record<string, TunableDefinition>;

export type TunableKey = keyof typeof TUNABLE_PARAMS;

const storage = new MMKV( { id: "tunable-params" } );

const readOverride = ( key: TunableKey ): number | undefined => storage.getNumber( key );

const clampTunable = ( key: TunableKey, value: number ) => {
  const { min, max, integer } = TUNABLE_PARAMS[key] as TunableDefinition;
  const clamped = Math.min( max, Math.max( min, value ) );
  return integer
    ? Math.round( clamped )
    : clamped;
};

export const getTunable = ( key: TunableKey ): number => {
  const override = readOverride( key );
  return override === undefined || !Number.isFinite( override )
    ? TUNABLE_PARAMS[key].default
    : clampTunable( key, override );
};

export const setTunable = ( key: TunableKey, value: number ) => {
  storage.set( key, clampTunable( key, value ) );
};

export const resetTunable = ( key: TunableKey ) => storage.delete( key );

export const resetAllTunables = ( ) => storage.clearAll( );

export const isTunableOverridden = ( key: TunableKey ) => readOverride( key ) !== undefined;
