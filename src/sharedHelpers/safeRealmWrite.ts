// this is based on safeWrite from this github issue, but customized for
// realmjs: https://stackoverflow.com/questions/39366182/the-realm-is-already-in-a-write-transaction
import type Realm from "realm";
import { recordRealmWrite } from "sharedHelpers/realmWriteStats";

const safeRealmWrite = (
  realm: Realm,
  action: () => void,
  description: string,
) => {
  if ( realm.isInTransaction ) {
    return action( );
  }
  // https://www.mongodb.com/docs/realm-sdks/react/latest/classes/Realm-1.html#beginTransaction.beginTransaction-1
  const started = Date.now( );
  realm.beginTransaction( );
  try {
    const response = action( );
    realm.commitTransaction( );
    recordRealmWrite( description, Date.now( ) - started );
    return response;
  } catch ( e ) {
    realm.cancelTransaction( );
    e.message = `${description}: ${e.message}`;
    throw e;
  }
};

export default safeRealmWrite;
