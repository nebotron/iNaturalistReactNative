import { t } from "i18next";
import BackgroundService from "react-native-background-actions";

const BACKGROUND_TASK_POLL_MS = 1000;
const UPLOAD_BACKGROUND_TASK_NAME = "observation-upload";

const sleep = ( ms: number ) => new Promise<void>( resolve => {
  setTimeout( resolve, ms );
} );

const uploadBackgroundTask = async ( ) => {
  await new Promise<void>( resolve => {
    const keepJsAlive = async ( ) => {
      while ( BackgroundService.isRunning( ) ) {
        // eslint-disable-next-line no-await-in-loop
        await sleep( BACKGROUND_TASK_POLL_MS );
      }
      resolve( );
    };
    keepJsAlive( );
  } );
};

const getBackgroundServiceOptions = ( ) => ( {
  taskName: UPLOAD_BACKGROUND_TASK_NAME,
  taskTitle: t( "Upload-in-progress" ),
  taskDesc: t( "Upload-your-observations-to-contribute-data-to-help-save-species" ),
  taskIcon: {
    name: "ic_launcher",
    type: "mipmap",
  },
  color: "#74ac00",
  foregroundServiceType: ["dataSync"],
  parameters: {},
} );

export const isBackgroundUploadTaskRunning = ( ) => BackgroundService.isRunning( );

export const beginBackgroundUploadTask = async ( ): Promise<boolean> => {
  if ( BackgroundService.isRunning( ) ) {
    return true;
  }

  try {
    await BackgroundService.start( uploadBackgroundTask, getBackgroundServiceOptions( ) );
    return true;
  } catch {
    return false;
  }
};

export const endBackgroundUploadTask = async ( ) => {
  if ( !BackgroundService.isRunning( ) ) {
    return;
  }

  try {
    await BackgroundService.stop( );
  } catch {
    // Ignore stop failures when the service is already shutting down.
  }
};
