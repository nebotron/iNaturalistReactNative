import { moveFile } from "@dr.pogodin/react-native-fs";
import { NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";
import { unlink } from "sharedHelpers/util";

const logger = log.extend( "chromaticAberration" );

// What ImageCropper.correctChromaticAberration reports back: it measures the
// red and blue channels against green and only rewrites the file when the
// fringing is big enough to see (see kCAMinCornerShiftPx in ImageCropper.m).
export interface ChromaticAberrationResult {
  applied: boolean;
  reason?: string;
  redScale?: number;
  blueScale?: number;
  redCornerPx?: number;
  blueCornerPx?: number;
  ms?: number;
}

export interface ChromaticAberrationSummary {
  corrected: number;
  skipped: number;
  failed: number;
  maxCornerPx: number;
  ms: number;
}

interface ImageCropperModule {
  correctChromaticAberration: (
    inputPath: string,
    outputPath: string,
  ) => Promise<ChromaticAberrationResult>;
}

const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };

export const chromaticAberrationCorrectionAvailable = ( ): boolean => (
  Platform.OS === "ios" && Boolean( ImageCropper?.correctChromaticAberration )
);

const stripScheme = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// Corrects one photo in place. The corrected pixels are written beside the
// original and only swapped in once they are safely on disk, and the original
// is kept until that swap has succeeded: a photo the user just imported is not
// worth losing to a correction that could have been skipped.
export async function correctPhotoChromaticAberration(
  localFileUri?: string | null,
): Promise<ChromaticAberrationResult | null> {
  if ( !localFileUri || !chromaticAberrationCorrectionAvailable( ) ) return null;
  const path = stripScheme( localFileUri );
  const workingPath = `${path}.ca-working.jpg`;
  const backupPath = `${path}.ca-original.jpg`;
  try {
    const result = await ImageCropper!.correctChromaticAberration( path, workingPath );
    if ( !result?.applied ) {
      await unlink( workingPath ).catch( ( ) => undefined );
      return result ?? null;
    }
    await moveFile( path, backupPath );
    try {
      await moveFile( workingPath, path );
    } catch ( error ) {
      // Put the photo back exactly as it was imported.
      await moveFile( backupPath, path );
      throw error;
    }
    await unlink( backupPath ).catch( ( ) => undefined );
    return result;
  } catch ( error ) {
    await unlink( workingPath ).catch( ( ) => undefined );
    logger.error(
      "Failed to correct chromatic aberration; keeping the photo as imported",
      error,
    );
    return null;
  }
}

// Two at a time: each correction holds two full-size pixel buffers, and the
// import is already resizing photos alongside this.
const CONCURRENCY = 2;

export async function correctPhotosChromaticAberration(
  localFileUris: ( string | null | undefined )[],
): Promise<ChromaticAberrationSummary> {
  const summary: ChromaticAberrationSummary = {
    corrected: 0, skipped: 0, failed: 0, maxCornerPx: 0, ms: 0,
  };
  const uris = localFileUris.filter( Boolean ) as string[];
  if ( uris.length === 0 || !chromaticAberrationCorrectionAvailable( ) ) return summary;

  const startedAt = Date.now( );
  for ( let i = 0; i < uris.length; i += CONCURRENCY ) {
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      uris.slice( i, i + CONCURRENCY ).map( correctPhotoChromaticAberration ),
    );
    results.forEach( result => {
      if ( !result ) {
        summary.failed += 1;
        return;
      }
      if ( result.applied ) {
        summary.corrected += 1;
        summary.maxCornerPx = Math.max(
          summary.maxCornerPx,
          result.redCornerPx ?? 0,
          result.blueCornerPx ?? 0,
        );
      } else {
        summary.skipped += 1;
      }
    } );
  }
  summary.ms = Date.now( ) - startedAt;
  return summary;
}

// The photo files an observation's photos were just written to.
export function localFileUrisForObservations(
  observations: { observationPhotos?: { photo?: { localFilePath?: string } }[] }[],
): string[] {
  return observations.flatMap( observation => (
    observation.observationPhotos ?? []
  ).map( obsPhoto => obsPhoto?.photo?.localFilePath ).filter( Boolean ) as string[] );
}
