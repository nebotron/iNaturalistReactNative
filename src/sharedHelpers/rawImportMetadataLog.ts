import * as Exify from "@lodev09/react-native-exify";
import type { Cr3Summary } from "sharedHelpers/cr3Metadata";
import { isCanonRawUri, readCr3SummaryFromFile } from "sharedHelpers/cr3Metadata";
import exifUri from "sharedHelpers/exifUri";
import { fileExtension, summarizeTypes } from "sharedHelpers/importedFileTypes";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "rawImportMetadataLog" );

// Long lists are trimmed rather than dropped: the point is to see what a file
// carries, but not at the cost of a log entry nothing will read.
const MAX_LIST_CHARS = 400;

const trim = ( value: string ) => ( value.length > MAX_LIST_CHARS
  ? `${value.slice( 0, MAX_LIST_CHARS )}…`
  : value );

const hexList = ( tags: number[] ) => trim(
  tags.map( tag => `0x${tag.toString( 16 )}` ).join( "," ),
);

// One curve per segment: kind, how many points, the value at the centre and at
// the outermost point, its range, and the knot table it was paired with.
const describeCurves = ( summary: Cr3Summary ) => trim( summary.curves.map( curve => (
  `${curve.kind}:${curve.points}:${curve.first.toFixed( 3 )}>${curve.last.toFixed( 3 )}`
  + `:[${curve.low.toFixed( 3 )},${curve.high.toFixed( 3 )}]:k${curve.knotCount}/${curve.knotLast}`
) ).join( "|" ) );

// The lens the JPEG kept is what the correction profile is keyed on
// (chromaticAberration.ts), so it is worth seeing beside what the raw held.
const exifSummary = async ( uri?: string | null ) => {
  if ( !uri ) {
    return {
      readable: false, tags: "", lens: "", focalLength: -1,
    };
  }
  try {
    const tags = await Exify.read( exifUri( uri ) );
    if ( !tags ) {
      return {
        readable: false, tags: "", lens: "", focalLength: -1,
      };
    }
    return {
      readable: true,
      tags: trim( Object.keys( tags ).sort( ).join( "," ) ),
      lens: String( tags.LensModel ?? tags.LensMake ?? "" ),
      focalLength: Number( tags.FocalLength ?? -1 ),
    };
  } catch {
    // A file ImageIO won't open is itself the finding.
    return {
      readable: false, tags: "", lens: "", focalLength: -1,
    };
  }
};

// Reports, once per import, what a Canon raw actually carried and how much of
// it survived into the JPEG the observation ends up with. Everything here is a
// property of the camera and lens, not of the photograph: no coordinates, no
// timestamps, no serial numbers — the tag *names* are listed, never their
// values.
async function logRawImportMetadata(
  sourceUris: ( string | null | undefined )[],
  derivedUris: ( string | null | undefined )[],
): Promise<Cr3Summary | null> {
  const source = sourceUris.find( uri => isCanonRawUri( uri ) );
  if ( !source ) {
    // Four imports of camera raws on Aug 20 produced no line at all here, which
    // says the uris an import carries are not the .CR3 files on disk. What they
    // are instead is the thing to know.
    logger.infoWithExtra( "raw_import_no_raw_source", {
      sources: sourceUris.length,
      types: summarizeTypes( sourceUris.map( uri => fileExtension( uri ) ) ),
      schemes: summarizeTypes( sourceUris.map( uri => (
        String( uri ?? "" ).split( ":" )[0] || "none"
      ) ) ),
    } );
    return null;
  }
  const derived = derivedUris.find( Boolean );

  try {
    const [summary, sourceExif, derivedExif] = await Promise.all( [
      readCr3SummaryFromFile( source ),
      exifSummary( source ),
      exifSummary( derived ),
    ] );
    if ( !summary ) {
      logger.warnWithExtra( "raw_import_metadata_unreadable", {
        sourceType: fileExtension( source ),
        sourceExifReadable: sourceExif.readable,
      } );
      return null;
    }

    logger.infoWithExtra( "raw_import_metadata", {
      sourceType: fileExtension( source ),
      make: summary.make ?? "",
      camera: summary.camera ?? "",
      lens: summary.lens ?? "",
      makerNoteLens: summary.makerNoteLens ?? "",
      focalLength: summary.focalLength ?? -1,
      fNumber: summary.fNumber ?? -1,
      iso: summary.iso ?? -1,
      sensor: `${summary.sensorWidth}x${summary.sensorHeight}`,
      active: `${summary.activeWidth}x${summary.activeHeight}`,
      crop: `${summary.cropWidth}x${summary.cropHeight}+${summary.cropLeft}+${summary.cropTop}`,
      inCameraCorrections: `periph=${summary.peripheralLighting} `
        + `ca=${summary.chromaticAberrationCorrection} `
        + `dist=${summary.distortionCorrection} dlo=${summary.digitalLensOptimizer}`,
      hasGps: Boolean( summary.hasGps ),
      exifTagCount: summary.exifTags.length,
      exifTags: hexList( summary.exifTags ),
      makerNoteTagCount: summary.makerNoteTags.length,
      makerNoteTags: hexList( summary.makerNoteTags ),
      ctmdRecords: summary.ctmdRecordTypes.join( "," ),
      lensPacket: `v${summary.packetVersion} ${summary.packetBytes}B`,
      curves: describeCurves( summary ),
      // What ImageIO makes of the same file, and of the JPEG the import
      // derived from it.
      sourceExifReadable: sourceExif.readable,
      sourceExifTags: sourceExif.tags,
      derivedType: fileExtension( derived ),
      derivedExifReadable: derivedExif.readable,
      derivedLens: derivedExif.lens,
      derivedFocalLength: derivedExif.focalLength,
      derivedExifTags: derivedExif.tags,
    } );
    return summary;
  } catch ( error ) {
    logger.error( "Could not read the metadata of an imported raw file", error );
    return null;
  }
}

export default logRawImportMetadata;
