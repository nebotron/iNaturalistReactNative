import {
  act, fireEvent, screen, waitFor,
} from "@testing-library/react-native";
import {
  MS_BEFORE_TOOLBAR_RESET,
  MS_BEFORE_UPLOAD_TIMES_OUT,
} from "components/MyObservations/hooks/useUploadObservations";
import MyObservationsContainer from "components/MyObservations/MyObservationsContainer";
import inatjs from "inaturalistjs";
import React from "react";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { MAX_CONCURRENT_UPLOADS } from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";
import factory, { makeResponse } from "tests/factory";
import faker from "tests/helpers/faker";
import { renderAppWithComponent } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

// Observations missing basics (evidence, taxon, date or location) never enter
// the upload queue, so give each one a photo and a taxon
const uploadableObservation = observedOnString => factory( "LocalObservation", {
  _synced_at: null,
  observed_on_string: observedOnString,
  latitude: 1.2345,
  longitude: 1.2345,
  taxon: factory( "LocalTaxon" ),
  observationPhotos: [
    factory( "LocalObservationPhoto", {
      photo: {
        url: faker.image.url( ),
        position: 0,
      },
    } ),
  ],
} );

const mockUnsyncedObservations = [
  uploadableObservation( "2024-05-01" ),
  uploadableObservation( "2024-05-02" ),
  uploadableObservation( "2024-05-03" ),
];

const mockUser = factory( "LocalUser", {
  login: faker.internet.userName( ),
  iconUrl: faker.image.url( ),
  locale: "en",
} );

jest.mock( "sharedHooks/useFontScale", () => ( {
  __esModule: true,
  default: ( ) => ( { isLargeFontScale: false } ),
} ) );

// UNIQUE REALM SETUP
const mockRealmIdentifier = __filename;
const { mockRealmModelsIndex, uniqueRealmBeforeAll, uniqueRealmAfterAll } = setupUniqueRealm(
  mockRealmIdentifier,
);
jest.mock( "realmModels/index", ( ) => mockRealmModelsIndex );
jest.mock( "providers/contexts", ( ) => {
  const originalModule = jest.requireActual( "providers/contexts" );
  const { makeRealmHooks } = jest.requireActual( "tests/helpers/uniqueRealm" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      ...makeRealmHooks( __filename ),
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const newAbortError = ( ) => {
  const error = new Error( "Aborted" );
  error.name = "AbortError";
  return error;
};

const successfulCreateResponse = uuid => makeResponse( [{
  id: faker.number.int( ),
  uuid,
}] );

const displayItemByText = text => {
  const item = screen.getByText( text );
  expect( item ).toBeVisible( );
};

const startUploadsViaSyncButton = async ( ) => {
  renderAppWithComponent( <MyObservationsContainer /> );
  await waitFor( ( ) => {
    displayItemByText( /Upload 3 observations/ );
  } );
  fireEvent.press( screen.getByTestId( "SyncButton" ) );
};

const advanceTimers = async ms => {
  await act( async ( ) => {
    jest.advanceTimersByTime( ms );
  } );
};

// Wait for the toolbar reset timeout so there aren't any pending async
// processes that interfere with subsequent tests
const waitForUploadStateReset = async ( ) => {
  await waitFor( ( ) => {
    expect( useStore.getState( ).uploadStatus ).toEqual( "pending" );
  }, { timeout: MS_BEFORE_TOOLBAR_RESET + 2000, interval: 500 } );
};

describe( "MyObservations upload queue", ( ) => {
  beforeEach( async ( ) => {
    setStoreStateLayout( {
      isDefaultMode: false,
      isAllAddObsOptionsMode: true,
    } );
    await signIn( mockUser, { realm: global.mockRealms[__filename] } );
    jest.useFakeTimers( );
    safeRealmWrite( global.mockRealms[__filename], ( ) => {
      mockUnsyncedObservations.forEach( mockObservation => {
        global.mockRealms[__filename].create( "Observation", mockObservation );
      } );
    }, "writing unsynced observations for MyObservationsUploadQueue integration test" );
    inatjs.observations.create.mockClear( );
    inatjs.observations.fetch.mockImplementation( ( uuid, _params, _opts ) => {
      const mockObs = mockUnsyncedObservations.find( o => o.uuid === uuid );
      return Promise.resolve( makeResponse( [mockObs] ) );
    } );
    inatjs.observation_photos.create.mockImplementation( async params => makeResponse( [{
      id: faker.number.int( ),
      uuid: params.observation_photo.uuid,
    }] ) );
    inatjs.photos.create.mockImplementation( ( ) => Promise.resolve( makeResponse( [{
      id: faker.number.int( ),
    }] ) ) );
  } );

  afterEach( async ( ) => {
    await signOut( { realm: global.mockRealms[__filename] } );
  } );

  it( "uploads remaining observations after one upload times out", async ( ) => {
    let hangingUuid;
    const uploadedUuids = [];
    inatjs.observations.create.mockImplementation( ( params, opts ) => {
      const { uuid } = params.observation;
      // The first queued upload hangs until its abort signal fires; the
      // pre-fix code let this strand the rest of the queue
      if ( inatjs.observations.create.mock.calls.length === 1 ) {
        hangingUuid = uuid;
        return new Promise( ( _resolve, reject ) => {
          opts.signal.addEventListener( "abort", ( ) => reject( newAbortError( ) ) );
        } );
      }
      uploadedUuids.push( uuid );
      return Promise.resolve( successfulCreateResponse( uuid ) );
    } );

    await startUploadsViaSyncButton( );
    await waitFor( ( ) => {
      expect( hangingUuid ).toBeTruthy( );
    } );
    await advanceTimers( MS_BEFORE_UPLOAD_TIMES_OUT + 1000 );
    await waitFor( ( ) => {
      expect( useStore.getState( ).errorsByUuid[hangingUuid] ).toContain( "aborted" );
    } );
    await waitFor( ( ) => {
      expect( uploadedUuids ).toHaveLength( 2 );
    } );
    expect( uploadedUuids ).not.toContain( hangingUuid );
    await waitFor( ( ) => {
      expect( useStore.getState( ).uploadStatus ).toEqual( "complete" );
    } );
    displayItemByText( /1 upload failed/ );
    displayItemByText( /2 observations uploaded/ );
    await waitForUploadStateReset( );
  } );

  it( "does not abort later uploads after an earlier upload fails quickly", async ( ) => {
    const firstUploadFailsAfterMs = 30_000;
    // The worker starts the whole batch at once and gives each upload its own
    // timeout, so the sibling still has to survive the moment the first
    // upload's failure could have orphaned a timer onto it
    const secondUploadResolvesAfterMs = 60_000;
    let failedUuid;
    let secondUploadAborted = false;
    const uploadedUuids = [];
    inatjs.observations.create.mockImplementation( ( params, opts ) => {
      const { uuid } = params.observation;
      const callNumber = inatjs.observations.create.mock.calls.length;
      if ( callNumber === 1 ) {
        failedUuid = uuid;
        return new Promise( ( _resolve, reject ) => {
          setTimeout(
            ( ) => reject( new TypeError( "Network request failed" ) ),
            firstUploadFailsAfterMs,
          );
        } );
      }
      if ( callNumber === 2 ) {
        return new Promise( ( resolve, reject ) => {
          opts.signal.addEventListener( "abort", ( ) => {
            secondUploadAborted = true;
            reject( newAbortError( ) );
          } );
          setTimeout( ( ) => {
            uploadedUuids.push( uuid );
            resolve( successfulCreateResponse( uuid ) );
          }, secondUploadResolvesAfterMs );
        } );
      }
      uploadedUuids.push( uuid );
      return Promise.resolve( successfulCreateResponse( uuid ) );
    } );

    await startUploadsViaSyncButton( );
    // The worker fills every concurrency slot at once
    await waitFor( ( ) => {
      expect( inatjs.observations.create ).toHaveBeenCalledTimes( 3 );
    } );
    await advanceTimers( firstUploadFailsAfterMs + 1000 );
    // This advance crosses the point where a timer orphaned by the first
    // failure would have aborted the whole session on pre-fix code
    await advanceTimers( secondUploadResolvesAfterMs );
    expect( secondUploadAborted ).toBe( false );
    // The network failure is retried rather than abandoned, so all three
    // observations land; what matters is that none of them was aborted
    await waitFor( ( ) => {
      expect( uploadedUuids ).toHaveLength( 3 );
    } );
    expect( uploadedUuids ).toContain( failedUuid );
    await waitFor( ( ) => {
      expect( useStore.getState( ).uploadStatus ).toEqual( "complete" );
    } );
    expect( useStore.getState( ).errorsByUuid ).toEqual( {} );
    await waitForUploadStateReset( );
  } );

  it( "cancels in-flight and queued uploads when user stops uploads", async ( ) => {
    let abortedCount = 0;
    // Every upload hangs, so the whole batch is still in flight when the user
    // stops it and nothing can advance the queue on its own
    inatjs.observations.create.mockImplementation( ( _params, opts ) => (
      new Promise( ( _resolve, reject ) => {
        opts.signal.addEventListener( "abort", ( ) => {
          abortedCount += 1;
          reject( newAbortError( ) );
        } );
      } )
    ) );

    await startUploadsViaSyncButton( );
    await waitFor( ( ) => {
      expect( inatjs.observations.create ).toHaveBeenCalledTimes( MAX_CONCURRENT_UPLOADS );
    } );
    const stopUploadButton = await screen.findByLabelText( "Stop upload" );
    fireEvent.press( stopUploadButton );
    await waitFor( ( ) => {
      expect( abortedCount ).toEqual( MAX_CONCURRENT_UPLOADS );
    } );
    // Give any erroneous queue advancement a chance to happen
    await advanceTimers( 1000 );
    expect( useStore.getState( ).uploadStatus ).toEqual( "cancelled" );
    // A user-initiated stop should not be recorded as an upload error
    expect( useStore.getState( ).errorsByUuid ).toEqual( {} );
    expect( inatjs.observations.create ).toHaveBeenCalledTimes( MAX_CONCURRENT_UPLOADS );
    await waitForUploadStateReset( );
  } );

  it( "uploads all observations in a new session after user cancelled", async ( ) => {
    let cancelled = false;
    inatjs.observations.create.mockImplementation( ( params, opts ) => {
      // Hang the whole first session so the user's stop leaves all three
      // observations still needing upload
      if ( !cancelled ) {
        return new Promise( ( _resolve, reject ) => {
          opts.signal.addEventListener( "abort", ( ) => reject( newAbortError( ) ) );
        } );
      }
      return Promise.resolve( successfulCreateResponse( params.observation.uuid ) );
    } );

    await startUploadsViaSyncButton( );
    await waitFor( ( ) => {
      expect( inatjs.observations.create ).toHaveBeenCalledTimes( MAX_CONCURRENT_UPLOADS );
    } );
    const stopUploadButton = await screen.findByLabelText( "Stop upload" );
    fireEvent.press( stopUploadButton );
    cancelled = true;
    // After the toolbar resets, all three observations still need upload
    await waitFor( ( ) => {
      displayItemByText( /Upload 3 observations/ );
    }, { timeout: MS_BEFORE_TOOLBAR_RESET + 2000, interval: 500 } );
    fireEvent.press( screen.getByTestId( "SyncButton" ) );
    await waitFor( ( ) => {
      displayItemByText( /3 observations uploaded/ );
    } );
    expect( useStore.getState( ).uploadStatus ).toEqual( "complete" );
    expect( useStore.getState( ).errorsByUuid ).toEqual( {} );
    await waitForUploadStateReset( );
  } );

  it( "does not drop an observation when a cancelled upload settles late", async ( ) => {
    let cancelled = false;
    let rejectStaleUpload;
    const uploadedUuids = [];
    inatjs.observations.create.mockImplementation( ( params, opts ) => {
      const { uuid } = params.observation;
      if ( !cancelled ) {
        if ( inatjs.observations.create.mock.calls.length === 1 ) {
          // Deliberately ignores opts.signal, so only the test settles it
          return new Promise( ( _resolve, reject ) => {
            rejectStaleUpload = ( ) => reject( newAbortError( ) );
          } );
        }
        return new Promise( ( _resolve, reject ) => {
          opts.signal.addEventListener( "abort", ( ) => reject( newAbortError( ) ) );
        } );
      }
      // Slow enough that the stale rejection lands mid-queue
      return new Promise( resolve => {
        setTimeout( ( ) => {
          uploadedUuids.push( uuid );
          resolve( successfulCreateResponse( uuid ) );
        }, 1000 );
      } );
    } );

    await startUploadsViaSyncButton( );
    await waitFor( ( ) => {
      expect( inatjs.observations.create ).toHaveBeenCalledTimes( MAX_CONCURRENT_UPLOADS );
    } );
    const stopUploadButton = await screen.findByLabelText( "Stop upload" );
    fireEvent.press( stopUploadButton );
    cancelled = true;
    await waitFor( ( ) => {
      displayItemByText( /Upload 3 observations/ );
    }, { timeout: MS_BEFORE_TOOLBAR_RESET + 2000, interval: 500 } );

    // Start a second session, then settle the abandoned first-session upload
    // while the second session still has observations queued
    fireEvent.press( screen.getByTestId( "SyncButton" ) );
    // The abandoned upload still owns its UUID, so the new session picks up
    // the two the user's stop actually released
    await waitFor( ( ) => {
      expect( inatjs.observations.create.mock.calls.length )
        .toBeGreaterThan( MAX_CONCURRENT_UPLOADS );
    } );
    await act( async ( ) => {
      rejectStaleUpload( );
    } );

    // Step the advance so each upload's promise and the effect that queues
    // the next one get a chance to flush between timer fires
    for ( let step = 0; step < 6 && uploadedUuids.length < 2; step += 1 ) {
      // eslint-disable-next-line no-await-in-loop
      await advanceTimers( 1500 );
    }
    expect( uploadedUuids ).toHaveLength( 2 );
    expect( new Set( uploadedUuids ).size ).toEqual( 2 );
    await waitForUploadStateReset( );
  } );
} );
