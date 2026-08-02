import type { Realm } from "@realm/react";
import { linkCropFeedbackUploadedUrlForPhoto } from "sharedHelpers/cropFeedbackLog";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

// Realm.Objects expose isValid(); the plain objects we sometimes get here
// don't, and those are never invalidated.
function isInvalidatedRealmObject( record: object ): boolean {
  return typeof record.isValid === "function" && !record.isValid( );
}

// Photos and Sounds are embedded objects with no UUID, so the only way back to
// a live one is through the observation's media, matched on the local file the
// upload came from.
function findEmbeddedMediaByLocalFile(
  realm: Realm,
  observationUUID: string,
  type: string,
  localFilePath?: string | null,
): object | null {
  if ( !localFilePath ) return null;
  const observation = realm.objectForPrimaryKey( "Observation", observationUUID );
  if ( !observation ) return null;
  if ( type === "Photo" ) {
    return observation.observationPhotos
      ?.map( op => op.photo )
      .find( photo => photo?.localFilePath === localFilePath ) || null;
  }
  return observation.observationSounds
    ?.map( os => os.sound )
    .find( sound => sound?.file_url === localFilePath ) || null;
}

function findRecordInRealm(
  realm: Realm,
  observationUUID: string,
  recordUUID: string | null,
  type: string,
  options?: {
    record: object;
    localFilePath?: string | null;
  },
): object | null {
  if ( !realm || realm.isClosed ) return null;

  // Photos and Sounds do not have UUIDs, so we pass the Photo/Sound itself as an option
  if ( ( type === "Photo" || type === "Sound" ) && options?.record ) {
    // An embedded Photo/Sound whose parent ObservationPhoto/ObservationSound
    // was replaced while the upload was in flight is invalidated, and handing
    // the same dead object back on retry just re-throws "Accessing object
    // which has been invalidated or deleted". Look for the live one instead.
    if ( isInvalidatedRealmObject( options.record ) ) {
      return findEmbeddedMediaByLocalFile( realm, observationUUID, type, options.localFilePath );
    }
    return options.record;
  }

  const observation = realm.objectForPrimaryKey( "Observation", observationUUID );
  if ( !observation ) return null;

  if ( type === "Observation" ) {
    return observation;
  } if ( type === "ObservationPhoto" ) {
    return observation.observationPhotos?.find( op => op.uuid === recordUUID ) || null;
  } if ( type === "ObservationSound" ) {
    return observation.observationSounds?.find( os => os.uuid === recordUUID ) || null;
  }

  return null;
}

function updateRecordWithServerId(
  realm: Realm,
  record: object,
  serverId: number,
  type: string,
  responseResult?: {
    url?: string;
  },
): void {
  safeRealmWrite( realm, ( ) => {
    record.id = serverId;
    record._synced_at = new Date( );
    if ( type === "Photo" && responseResult?.url ) {
      record.url = responseResult.url;
      linkCropFeedbackUploadedUrlForPhoto( record, responseResult.url );
    }
    if ( type === "Observation" ) {
      record.needs_sync = false;
    }
  }, `marking record uploaded in realmSync.js, type: ${type}` );
}

function handleRecordUpdateError(
  error: Error,
  realm: Realm,
  observationUUID: string,
  recordUUID: string | null,
  type: string,
  serverId: number,
  options?: {
    record: object;
    localFilePath?: string | null;
    responseResult?: {
      url?: string;
    };
  },
): void {
  // Try it one more time in case it was invalidated but it's still in the
  // database
  if ( error.message.match( /invalidated or deleted/ ) ) {
    const refreshedRecord
        = findRecordInRealm( realm, observationUUID, recordUUID, type, options );
    if ( !refreshedRecord ) {
      throw new Error(
        `Cannot find local Realm object on retry (${type}), recordUUID: ${recordUUID || ""}`,
      );
    }
    updateRecordWithServerId( realm, refreshedRecord, serverId, type, options?.responseResult );
  } else {
    // For other errors, just log and re-throw
    console.error( `Error updating record in Realm: ${error.message}` );
    throw error;
  }
}

// The reason this doesn't simply accept the record is because we're not being
// strict about using Realm.Objects, so sometimes the thing we just uploaded
// is a Realm.Object and sometimes it's a POJO, but in order to mark it as
// uploaded and add a server-assigned id attribute, we need to find the
// matching Realm.Object
const markRecordUploaded = (
  observationUUID: string,
  recordUUID: string | null,
  type: string,
  response: {
    results: {id: number}[];
  },
  realm: Realm,
  options?: {
    record: object;
    localFilePath?: string | null;
    responseResult?: {
      url?: string;
    };
  },
) => {
  if ( !realm || realm.isClosed ) return;

  const { id, ...responseResult } = response.results[0];

  const record = findRecordInRealm( realm, observationUUID, recordUUID, type, options );

  if ( !record ) {
    throw new Error(
      // eslint-disable-next-line max-len
      `Cannot find local Realm object to mark as updated (${type}), recordUUID: ${recordUUID || ""}`,
    );
  }

  try {
    updateRecordWithServerId( realm, record, id, type, responseResult );
  } catch ( realmWriteError ) {
    handleRecordUpdateError(
      realmWriteError,
      realm,
      observationUUID,
      recordUUID,
      type,
      id,
      options,
    );
  }
};

export default markRecordUploaded;
