import { moveFile } from "@dr.pogodin/react-native-fs";
import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";
import exifUri from "sharedHelpers/exifUri";
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
  measured: number;
  fromProfile: number;
  lenses: number;
  maxCornerPx: number;
  ms: number;
}

export interface LensProfile {
  red: number;
  blue: number;
  samples: number;
}

interface ImageCropperModule {
  correctChromaticAberration: (
    inputPath: string,
    outputPath: string,
  ) => Promise<ChromaticAberrationResult>;
  applyChromaticAberration: (
    inputPath: string,
    outputPath: string,
    redScale: number,
    blueScale: number,
  ) => Promise<ChromaticAberrationResult>;
}

const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };

export const chromaticAberrationCorrectionAvailable = ( ): boolean => (
  Platform.OS === "ios" && Boolean( ImageCropper?.correctChromaticAberration )
);

const stripScheme = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// ─── Lens profiles ───────────────────────────────────────────────────────────
//
// Lateral CA is a property of the lens, not of the photo: the same lens at the
// same focal length fringes the same way in every frame it takes. A raw file
// carries the lens it was taken with, and that survives into the JPEG the
// import writes, so a shift measured on one frame can be reused for the rest —
// which is both faster and better. Measurement needs edges spread across the
// frame; a photo of open sky or a close subject against a blank background has
// none, and would otherwise go uncorrected.
//
// (The lens correction packet Canon writes into a CR3 for each exposure is a
// different thing: it holds curves, but none of them matches the measured
// aberration, and it lives in the raw container rather than in EXIF, so it is
// gone by the time the import has a JPEG. See tools/craw/README.md.)

const profileStore = new MMKV( { id: "lens-ca-profiles" } );
const PROFILES_KEY = "profiles";

// Two frames of a lens before its profile is trusted for the rest: one
// measurement can be thrown off by a subject that fringes on its own.
const MIN_SAMPLES_TO_TRUST = 2;
// Stop averaging in new frames once the profile has settled, so a long import
// isn't re-weighting a value that stopped moving.
const MAX_SAMPLES = 20;

// Aperture is deliberately not part of the key: lateral CA is a difference in
// magnification between the channels, which stopping down does not change.
export function lensProfileKey( tags?: ExifTags | null ): string | null {
  const lens = String( tags?.LensModel || tags?.LensMake || "" ).trim( );
  const focalLength = Number( tags?.FocalLength );
  if ( !lens || !Number.isFinite( focalLength ) || focalLength <= 0 ) return null;
  return `${lens}@${Math.round( focalLength )}mm`;
}

function readProfiles( ): Record<string, LensProfile> {
  try {
    return JSON.parse( profileStore.getString( PROFILES_KEY ) ?? "{}" );
  } catch {
    return {};
  }
}

export function lensProfile( key?: string | null ): LensProfile | null {
  if ( !key ) return null;
  return readProfiles( )[key] ?? null;
}

export function recordLensMeasurement( key: string, red: number, blue: number ): LensProfile {
  const profiles = readProfiles( );
  const previous = profiles[key];
  const samples = Math.min( ( previous?.samples ?? 0 ) + 1, MAX_SAMPLES );
  const weight = previous
    ? Math.min( previous.samples, MAX_SAMPLES - 1 )
    : 0;
  const next: LensProfile = {
    red: ( ( previous?.red ?? 0 ) * weight + red ) / ( weight + 1 ),
    blue: ( ( previous?.blue ?? 0 ) * weight + blue ) / ( weight + 1 ),
    samples,
  };
  profiles[key] = next;
  profileStore.set( PROFILES_KEY, JSON.stringify( profiles ) );
  return next;
}

// How many lens/focal-length combinations have a profile. Cumulative across
// imports, which is what makes it worth logging: it says how much of the next
// import will need no measuring.
export function knownLensProfileCount( ): number {
  return Object.keys( readProfiles( ) ).length;
}

export function forgetLensProfiles( ): void {
  profileStore.delete( PROFILES_KEY );
}

async function lensKeyForPhoto( localFileUri: string ): Promise<string | null> {
  try {
    return lensProfileKey( await Exify.read( exifUri( localFileUri ) ) );
  } catch {
    // A photo whose EXIF won't read just gets measured on its own.
    return null;
  }
}

// Corrects one photo in place. The corrected pixels are written beside the
// original and only swapped in once they are safely on disk, and the original
// is kept until that swap has succeeded: a photo the user just imported is not
// worth losing to a correction that could have been skipped.
export async function correctPhotoChromaticAberration(
  localFileUri?: string | null,
  profile?: LensProfile | null,
): Promise<ChromaticAberrationResult | null> {
  if ( !localFileUri || !chromaticAberrationCorrectionAvailable( ) ) return null;
  const path = stripScheme( localFileUri );
  const workingPath = `${path}.ca-working.jpg`;
  const backupPath = `${path}.ca-original.jpg`;
  try {
    const result = profile
      ? await ImageCropper!.applyChromaticAberration(
        path,
        workingPath,
        profile.red,
        profile.blue,
      )
      : await ImageCropper!.correctChromaticAberration( path, workingPath );
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
    corrected: 0,
    skipped: 0,
    failed: 0,
    measured: 0,
    fromProfile: 0,
    lenses: 0,
    maxCornerPx: 0,
    ms: 0,
  };
  const uris = localFileUris.filter( Boolean ) as string[];
  if ( uris.length === 0 || !chromaticAberrationCorrectionAvailable( ) ) return summary;

  const startedAt = Date.now( );
  const lenses = new Set<string>( );
  for ( let i = 0; i < uris.length; i += CONCURRENCY ) {
    // Which photos can skip measuring is decided a chunk at a time, so the
    // frames measured at the start of an import spare the rest of it.
    // eslint-disable-next-line no-await-in-loop
    const chunk = await Promise.all(
      uris.slice( i, i + CONCURRENCY ).map( async uri => {
        const key = await lensKeyForPhoto( uri );
        const profile = lensProfile( key );
        return {
          uri,
          key,
          profile: profile && profile.samples >= MIN_SAMPLES_TO_TRUST
            ? profile
            : null,
        };
      } ),
    );
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(
      chunk.map( photo => correctPhotoChromaticAberration( photo.uri, photo.profile ) ),
    );
    results.forEach( ( result, index ) => {
      const { key, profile } = chunk[index];
      if ( key ) lenses.add( key );
      if ( !result ) {
        summary.failed += 1;
        return;
      }
      if (
        result.measured
        && key
        && typeof result.redScale === "number"
        && typeof result.blueScale === "number"
      ) {
        summary.measured += 1;
        recordLensMeasurement( key, result.redScale, result.blueScale );
      }
      if ( profile ) summary.fromProfile += 1;
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
  summary.lenses = lenses.size;
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
