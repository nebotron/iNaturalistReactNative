import { mkdir } from "@dr.pogodin/react-native-fs";
import { soundUploadPath } from "appConstants/paths";
import { NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";
import * as uuid from "uuid";

const logger = log.extend( "extractAudioFromVideo" );

interface VideoAudioExtractorModule {
  extractAudio: ( videoPath: string, outputPath: string ) => Promise<string>;
}

const { VideoAudioExtractor } = NativeModules as {
  VideoAudioExtractor?: VideoAudioExtractorModule;
};

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

const extractAudioFromVideo = async ( videoUri: string ): Promise<string> => {
  if ( !VideoAudioExtractor?.extractAudio ) {
    throw new Error( "VideoAudioExtractor native module is unavailable" );
  }

  await mkdir( soundUploadPath );
  const extension = Platform.OS === "android" ? "mp4" : "m4a";
  const outputPath = `${soundUploadPath}/${uuid.v4()}.${extension}`;
  const inputPath = stripFilePrefix( videoUri );

  try {
    const extractedPath = await VideoAudioExtractor.extractAudio( inputPath, outputPath );
    return `file://${extractedPath}`;
  } catch ( error ) {
    logger.error( "Failed to extract audio from video", error );
    throw error;
  }
};

export default extractAudioFromVideo;
