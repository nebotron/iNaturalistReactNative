import { QueryClient } from "@tanstack/react-query";
import { NativeModules } from "react-native";
import type * as Watermark from "sharedHelpers/memoryWatermark";

jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      warnWithExtra: jest.fn( ),
      infoWithExtra: jest.fn( ),
    } ),
  },
} ) );

// Lets the promise chain behind noteScreenMemory finish
const settle = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

describe( "memoryWatermark snapshot context", ( ) => {
  const memorySnapshot = jest.fn( async ( ) => ( {} ) );
  let watermark: typeof Watermark;

  beforeEach( ( ) => {
    memorySnapshot.mockClear( );
    ( NativeModules as { ImageCropper?: unknown } ).ImageCropper = {
      memoryStats: jest.fn( async ( ) => ( { footprintMB: 2600, freeMB: 500 } ) ),
      memorySnapshot,
      memoryCounters: jest.fn( async ( ) => ( {} ) ),
    };
    jest.isolateModules( ( ) => {
      watermark = jest.requireActual<typeof Watermark>( "sharedHelpers/memoryWatermark" );
    } );
  } );

  afterEach( ( ) => {
    delete ( NativeModules as { ImageCropper?: unknown } ).ImageCropper;
  } );

  it( "counts the React Query cache in the persisted snapshot", async ( ) => {
    const queryClient = new QueryClient( );
    queryClient.setQueryData( ["exploreObservations"], {
      pages: [{ results: [1, 2, 3] }, { results: [4, 5] }],
      pageParams: [1, 2],
    } );
    queryClient.setQueryData( ["fetchTaxon", 1], { results: [{ id: 1 }] } );
    queryClient.setQueryData( ["speciesList"], [1, 2, 3, 4] );
    watermark.setMemoryQueryClient( queryClient );

    watermark.noteScreenMemory( "ExploreResults" );
    await settle( );

    const context = memorySnapshot.mock.calls
      .map( ( [arg] ) => arg as Record<string, unknown> | null )
      .find( arg => arg !== null );
    expect( context ).toMatchObject( {
      screen: "ExploreResults",
      queryCache: {
        queries: 3, observed: 0, pages: 2, results: 10,
      },
    } );
    // Jest runs without Hermes
    expect( context?.js ).toBeNull( );
    queryClient.clear( );
  } );
} );
