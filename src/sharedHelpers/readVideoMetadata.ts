import { NativeModules } from "react-native";
import { formatISONoTimezone } from "sharedHelpers/dateAndTime";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "readVideoMetadata" );

export interface VideoMediaMetadata {
  latitude?: number;
  longitude?: number;
  observed_on_string?: string | null;
  positional_accuracy?: number;
}

interface VideoAudioExtractorModule {
  getVideoMetadata: (
    videoPath: string,
    assetId: string | null,
  ) => Promise<{
    latitude?: number;
    longitude?: number;
    timestamp?: string;
    positional_accuracy?: number;
  }>;
}

const { VideoAudioExtractor } = NativeModules as {
  VideoAudioExtractor?: VideoAudioExtractorModule;
};

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

const parseVideoTimestamp = ( timestamp?: string ): string | null => {
  if ( !timestamp ) return null;

  const isoMatch = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
  if ( isoMatch ) {
    const date = new Date( timestamp );
    if ( Number.isNaN( date.getTime() ) ) return null;
    return formatISONoTimezone( date );
  }

  const compactMatch = timestamp.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/,
  );
  if ( compactMatch ) {
    const [
      , year, month, day, hour, minute, second,
    ] = compactMatch;
    const date = new Date( Date.UTC(
      Number( year ),
      Number( month ) - 1,
      Number( day ),
      Number( hour ),
      Number( minute ),
      Number( second ),
    ) );
    if ( Number.isNaN( date.getTime() ) ) return null;
    return formatISONoTimezone( date );
  }

  return null;
};

const readVideoMetadata = async (
  videoUri: string,
  assetId?: string | null,
): Promise<VideoMediaMetadata> => {
  if ( !VideoAudioExtractor?.getVideoMetadata ) {
    return {};
  }

  try {
    const metadata = await VideoAudioExtractor.getVideoMetadata(
      stripFilePrefix( videoUri ),
      assetId || null,
    );

    return {
      latitude: metadata.latitude,
      longitude: metadata.longitude,
      positional_accuracy: metadata.positional_accuracy,
      observed_on_string: parseVideoTimestamp( metadata.timestamp ),
    };
  } catch ( error ) {
    logger.error( "Failed to read video metadata", error );
    return {};
  }
};

export const readMetadataFromMultipleVideos = async (
  videos: {
    uri: string;
    assetId?: string | null;
  }[],
): Promise<VideoMediaMetadata> => {
  const unifiedMetadata: VideoMediaMetadata = {};

  const metadataResults = await Promise.allSettled(
    videos.map( video => readVideoMetadata( video.uri, video.assetId ) ),
  );

  metadataResults.forEach( result => {
    if ( result.status !== "fulfilled" ) {
      logger.error( "Failed to read metadata from a video:", result.reason );
      return;
    }

    const videoMetadata = result.value;
    if ( !unifiedMetadata.latitude && videoMetadata.latitude ) {
      unifiedMetadata.latitude = videoMetadata.latitude;
    }
    if ( !unifiedMetadata.longitude && videoMetadata.longitude ) {
      unifiedMetadata.longitude = videoMetadata.longitude;
    }
    if ( !unifiedMetadata.observed_on_string && videoMetadata.observed_on_string ) {
      unifiedMetadata.observed_on_string = videoMetadata.observed_on_string;
    }
    if ( !unifiedMetadata.positional_accuracy && videoMetadata.positional_accuracy ) {
      unifiedMetadata.positional_accuracy = videoMetadata.positional_accuracy;
    }
  } );

  return unifiedMetadata;
};

export default readVideoMetadata;
