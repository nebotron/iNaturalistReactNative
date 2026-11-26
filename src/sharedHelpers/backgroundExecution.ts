import { t } from "i18next";
import BackgroundService from "react-native-background-actions";
import { sleep } from "sharedHelpers/util";

const BACKGROUND_TASK_POLL_MS = 1000;
const BACKGROUND_TASK_NAME = "inaturalist-background-task";

const backgroundTask = async ( ) => {
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
  taskName: BACKGROUND_TASK_NAME,
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

// A single native background task is shared by every feature that needs extra
// execution time after backgrounding (observation upload, USB auto-import).
// Reference-counted so one caller finishing doesn't cut off another that's
// still relying on it.
let activeCallers = 0;

const beginSharedBackgroundTask = async ( ): Promise<boolean> => {
  activeCallers += 1;
  if ( BackgroundService.isRunning( ) ) {
    return true;
  }

  try {
    await BackgroundService.start( backgroundTask, getBackgroundServiceOptions( ) );
    return true;
  } catch {
    activeCallers = Math.max( 0, activeCallers - 1 );
    return false;
  }
};

const endSharedBackgroundTask = async ( ) => {
  activeCallers = Math.max( 0, activeCallers - 1 );
  if ( activeCallers > 0 || !BackgroundService.isRunning( ) ) {
    return;
  }

  try {
    await BackgroundService.stop( );
  } catch {
    // Ignore stop failures when the service is already shutting down.
  }
};

export const beginBackgroundUploadTask = ( ) => beginSharedBackgroundTask( );
export const endBackgroundUploadTask = ( ) => endSharedBackgroundTask( );

export const beginBackgroundUsbImportTask = ( ) => beginSharedBackgroundTask( );
export const endBackgroundUsbImportTask = ( ) => endSharedBackgroundTask( );
