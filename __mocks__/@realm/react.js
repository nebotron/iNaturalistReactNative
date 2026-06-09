// Mock for @realm/react that delegates to the realm mock.
const MockRealm = require( "../realm.js" );

module.exports = {
  Realm: MockRealm,
  createRealmContext: ( ) => ( {
    RealmProvider: ( { children } ) => children,
    useRealm: ( ) => global.realm,
    useObject: ( ) => null,
    useQuery: ( ) => [],
  } ),
};
