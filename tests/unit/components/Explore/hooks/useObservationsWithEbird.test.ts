import { renderHook } from "@testing-library/react-native";
import useObservationsWithEbird from "components/Explore/hooks/useObservationsWithEbird";
import useStore from "stores/useStore";

const mockEbird = jest.fn( );
jest.mock( "components/Explore/hooks/useEbirdObservations", ( ) => ( {
  __esModule: true,
  default: ( ) => mockEbird( ),
} ) );

const inat = ( uuid: string, date: string ) => ( { uuid, time_observed_at: date } );
const ebird = ( uuid: string, date: string ) => ( {
  uuid, time_observed_at: date, ebirdChecklistUrl: `https://ebird.org/checklist/${uuid}`,
} );

const INAT = [inat( "i1", "2026-10-30" ), inat( "i2", "2026-10-20" )];
const EBIRD = [ebird( "e1", "2026-10-10" ), ebird( "e2", "2026-10-25" )];

const uuids = ( params: Record<string, unknown>, complete: boolean ) => renderHook(
  ( ) => useObservationsWithEbird( INAT, params, { enabled: true, complete } ),
).result.current.observations.map( obs => obs.uuid );

describe( "useObservationsWithEbird", ( ) => {
  beforeEach( ( ) => {
    mockEbird.mockReturnValue( { limits: [], observations: EBIRD } );
  } );

  it( "merges sightings into results in sort order", ( ) => {
    expect( uuids( { order_by: "observed_on", order: "desc" }, true ) )
      .toEqual( ["i1", "e2", "i2", "e1"] );
  } );

  it( "holds back sightings that sort after the last loaded page", ( ) => {
    expect( uuids( { order_by: "observed_on", order: "desc" }, false ) )
      .toEqual( ["i1", "e2", "i2"] );
  } );

  it( "puts sightings last when sorting by faves", ( ) => {
    expect( uuids( { order_by: "votes", order: "desc" }, true ) )
      .toEqual( ["i1", "i2", "e1", "e2"] );
    expect( uuids( { order_by: "votes", order: "desc" }, false ) ).toEqual( ["i1", "i2"] );
  } );

  it( "leaves results alone without eBird", ( ) => {
    mockEbird.mockReturnValue( null );
    expect( uuids( { order_by: "observed_on", order: "desc" }, true ) ).toEqual( ["i1", "i2"] );
  } );

  it( "shows only sorted sightings when eBird is the source", ( ) => {
    useStore.setState( state => ( {
      layout: { ...state.layout, observationSource: "ebird" },
    } ) );
    expect( uuids( { order_by: "observed_on", order: "desc" }, false ) )
      .toEqual( ["e2", "e1"] );
    useStore.setState( state => ( {
      layout: { ...state.layout, observationSource: "inaturalist" },
    } ) );
  } );
} );
