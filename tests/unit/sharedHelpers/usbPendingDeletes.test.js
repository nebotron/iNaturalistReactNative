import {
  addPendingUsbDeletes,
  clearPendingUsbDeletes,
  getPendingUsbDeletes,
} from "sharedHelpers/usbStorage";

// The MMKV store the helpers write to, in memory.
const mockStore = new Map( );

jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: class {
    // eslint-disable-next-line class-methods-use-this
    getString( key ) { return mockStore.get( key ); }

    // eslint-disable-next-line class-methods-use-this
    set( key, value ) { mockStore.set( key, value ); }

    // eslint-disable-next-line class-methods-use-this
    delete( key ) { mockStore.delete( key ); }
  },
} ) );

const DAY_MS = 24 * 60 * 60 * 1000;

describe( "pending USB deletions", ( ) => {
  beforeEach( ( ) => {
    mockStore.clear( );
    jest.useRealTimers( );
  } );

  // Each file is marked imported the moment it saves, but the card is only
  // emptied once the whole batch is saved. A run iOS suspends in between would
  // otherwise leave those photos on the card and invisible to every later scan.
  it( "remembers files saved but not yet deleted from the card", ( ) => {
    addPendingUsbDeletes( ["IMG_1.CR3", "IMG_2.CR3"] );

    expect( getPendingUsbDeletes( ) ).toEqual( ["IMG_1.CR3", "IMG_2.CR3"] );
  } );

  it( "forgets a path once the card has deleted it", ( ) => {
    addPendingUsbDeletes( ["IMG_1.CR3", "IMG_2.CR3"] );
    clearPendingUsbDeletes( ["IMG_1.CR3"] );

    expect( getPendingUsbDeletes( ) ).toEqual( ["IMG_2.CR3"] );
  } );

  // Nothing in a relative path says which card it came from, and a freshly
  // formatted card starts numbering at IMG_0001 again. An entry old enough to
  // have outlived the card that produced it must never be handed to a delete:
  // the file it names may be a photo on another card that was never imported.
  it( "will not delete a path older than the card that produced it", ( ) => {
    jest.useFakeTimers( ).setSystemTime( new Date( "2026-09-01T00:00:00Z" ) );
    addPendingUsbDeletes( ["IMG_1.CR3"] );

    jest.setSystemTime( new Date( "2026-09-01T00:00:00Z" ).getTime( ) + DAY_MS + 1000 );

    expect( getPendingUsbDeletes( ) ).toEqual( [] );
  } );

  it( "still deletes a path from the run that just saved it", ( ) => {
    jest.useFakeTimers( ).setSystemTime( new Date( "2026-09-01T00:00:00Z" ) );
    addPendingUsbDeletes( ["IMG_1.CR3"] );

    // The ordinary case: the next scan, ten seconds later.
    jest.setSystemTime( new Date( "2026-09-01T00:00:00Z" ).getTime( ) + 10_000 );

    expect( getPendingUsbDeletes( ) ).toEqual( ["IMG_1.CR3"] );
  } );
} );
