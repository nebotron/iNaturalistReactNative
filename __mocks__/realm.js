// Minimal Realm mock for Jest (no native binary required).
// Provides an in-memory store sufficient for unit tests.

class RealmObject {
  isValid() { return true; }
  toJSON() { return { ...this }; }
}

class RealmResults extends Array {
  filtered( ) { return this; }
  sorted( ) { return this; }
}

class MockRealm {
  constructor() {
    this._store = {};
  }

  static async open( ) {
    return new MockRealm();
  }

  static shutdown( ) {}

  write( callback ) {
    return callback();
  }

  create( type, data, mode ) {
    if ( !this._store[type] ) {
      this._store[type] = {};
    }
    const primaryKeys = { Observation: "uuid", Taxon: "id", User: "id" };
    const pk = primaryKeys[type] || "id";
    const key = data[pk];
    const obj = Object.assign( Object.create( RealmObject.prototype ), data );
    if ( key != null ) {
      this._store[type][key] = obj;
    }
    return obj;
  }

  objects( type ) {
    const items = Object.values( this._store[type] || {} );
    const results = RealmResults.from( items );
    results.filtered = function() { return this; };
    results.sorted = function() { return this; };
    return results;
  }

  objectForPrimaryKey( type, key ) {
    return ( this._store[type] || {} )[key] ?? null;
  }

  delete( obj ) {
    if ( !obj ) return;
    for ( const type of Object.keys( this._store ) ) {
      const store = this._store[type];
      for ( const key of Object.keys( store ) ) {
        if ( store[key] === obj ) {
          delete store[key];
        }
      }
    }
  }

  close( ) {}

  addListener( ) {}
  removeListener( ) {}
  removeAllListeners( ) {}
}

MockRealm.Object = RealmObject;
MockRealm.Results = RealmResults;
MockRealm.defaultPath = "/tmp/default.realm";

module.exports = MockRealm;
module.exports.default = MockRealm;
module.exports.Realm = MockRealm;
