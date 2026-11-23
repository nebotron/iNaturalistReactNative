import {
  appendFile, exists, mkdir, readDir, readFile, writeFile,
} from "@dr.pogodin/react-native-fs";
import { log } from "sharedHelpers/logger";
import { unlink } from "sharedHelpers/util";

import { sentinelFilePath } from "../appConstants/paths";

const logger = log.extend( "sentinelFiles" );

// a sentinel with this stage is considered "clean" and not in need of reporting
const FLOW_COMPLETE_STAGE = "flow_complete";

// A sentinel file is one JSON line for the flow, then one appended line per
// stage, so logging a stage is a short append. It used to read, parse and
// rewrite the whole file at every stage of the camera and import flows.
interface SentinelStage {
  name: string;
  timestamp: string;
}

interface SentinelData {
  screenName?: string;
  entryTimestamp?: string;
  stages: SentinelStage[];
}

// Reads either layout: files a build before the append format left behind
// hold a single JSON object with every stage in it.
export const parseSentinelContent = ( content: string ): SentinelData => {
  const lines = content.split( "\n" ).filter( line => line.trim( ) );
  const first = JSON.parse( lines[0] ?? "{}" );
  // A stage appended after its file was removed starts a file of its own
  const startsWithStage = !( "stages" in first ) && "name" in first;
  const data = startsWithStage
    ? { stages: [] }
    : first;
  const stages: SentinelStage[] = [...( data.stages || [] )];
  ( startsWithStage
    ? lines
    : lines.slice( 1 ) ).forEach( line => {
    try {
      stages.push( JSON.parse( line ) );
    } catch {
      // A line cut short by the app dying mid-write; the stages before it stand
    }
  } );
  return { ...data, stages };
};

const accessFullFilePath = ( fileName: string ) => `${sentinelFilePath}/${fileName}`;

const generateSentinelFileName = ( screenName: string ): string => {
  const timestamp = new Date().getTime();
  return `sentinel_${screenName}_${timestamp}.log`;
};

const createSentinelFile = async ( screenName: string ): Promise<string> => {
  try {
    await mkdir( sentinelFilePath );
    const sentinelFileName = generateSentinelFileName( screenName );

    const logEntry = {
      screenName,
      entryTimestamp: new Date( ).toISOString( ),
      stages: [],
    };

    const initialContent = `${JSON.stringify( logEntry )}\n`;

    await writeFile( accessFullFilePath( sentinelFileName ), initialContent, "utf8" );
    return sentinelFileName;
  } catch ( error ) {
    console.error( "Failed to create sentinel file:", error );
    return "";
  }
};

const logStage = async (
  sentinelFileName: string,
  stageName: string,
): Promise<void> => {
  if ( !sentinelFileName ) return;
  const fullFilePath = accessFullFilePath( sentinelFileName );
  try {
    const stage: SentinelStage = {
      name: stageName,
      timestamp: new Date( ).toISOString( ),
    };
    await appendFile( fullFilePath, `${JSON.stringify( stage )}\n`, "utf8" );
  } catch ( error ) {
    console.log( error, sentinelFileName, stageName, "Failed to log stage to sentinel file" );
    console.error( "Failed to log stage to sentinel file:", error, sentinelFileName, stageName );
  }
};

// marks flow as complete / non-problematic. sentinel flow writes are fire-and-forget
// by design so that we don't hang during the critical path. We might have in-flight
// flow writes at the time of "success" so instead of deleting the sentinel file, mark
// as complete and let startup handle cleanup
const completeSentinelFile = ( sentinelFileName: string ): Promise<void> => logStage(
  sentinelFileName,
  FLOW_COMPLETE_STAGE,
);

const logSentinelFiles = async ( ) => {
  const directoryExists = await exists( sentinelFilePath );
  if ( !directoryExists ) { return; }
  const files = await readDir( sentinelFilePath );

  files.forEach( async file => {
    try {
      const existingContent = await readFile( file.path, "utf8" );
      const { stages } = parseSentinelContent( existingContent );
      const completedNormally = stages
        .some( stage => stage.name === FLOW_COMPLETE_STAGE );
      if ( stages.length > 0 && !completedNormally ) {
        logger.error( "Camera flow error: ", existingContent );
      }
    } catch ( error ) {
      logger.error( "Failed to process sentinel file:", error, file.path );
    } finally {
      await unlink( file.path );
    }
  } );
};

export {
  completeSentinelFile,
  createSentinelFile,
  logSentinelFiles,
  logStage,
};
