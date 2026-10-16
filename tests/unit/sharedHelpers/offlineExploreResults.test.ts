import mockOs from "os";
import mockPath from "path";
import {
  downloadOfflineExploreResults,
  offlineExploreRealmConfig,
  openOfflineExploreRealm,
  queryOfflineObservations,
} from "sharedHelpers/offlineExploreResults";

const mockSearchObservations = jest.fn( );
jest.mock( "api/observations", ( ) => ( {
  searchObservations: ( ...args: unknown[] ) => mockSearchObservations( ...args ),
} ) );
jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( null ) ),
} ) );

const bird = {
  uuid: "a",
  created_at: "2024-05-02T10:00:00Z",
  observed_on: "2024-05-01",
  time_observed_at: "2024-05-01T07:30:00-07:00",
  quality_grade: "research",
  taxon: { id: 3, ancestor_ids: [1, 2, 3], iconic_taxon_name: "Aves" },
  observation_photos: [{}],
  user: { id: 10 },
  place_ids: [7],
  geojson: { coordinates: [-122, 37] },
};
const plant = {
  uuid: "b",
  created_at: "2024-08-02T10:00:00Z",
  observed_on: "2024-08-01",
  time_observed_at: "2024-08-01T15:00:00-07:00",
  quality_grade: "needs_id",
  taxon: { id: 5, ancestor_ids: [1, 4, 5], iconic_taxon_name: "Plantae" },
  observation_sounds: [{}],
  user: { id: 11 },
};

const respond = ( results: unknown[] ) => mockSearchObservations
  .mockResolvedValueOnce( { results, total_results: results.length } );

const uuids = async ( params: Record<string, unknown> ) => {
  const db = await openOfflineExploreRealm( );
  return queryOfflineObservations( db!, params ).map( o => o.uuid );
};

beforeAll( async ( ) => {
  offlineExploreRealmConfig.inMemory = true;
  offlineExploreRealmConfig.path = mockPath.join( mockOs.tmpdir( ), "offlineExplore.realm" );
  respond( [bird] );
  await downloadOfflineExploreResults( { taxon_id: 3 } );
  // A second save adds to the first without duplicating the bird
  respond( [bird, plant] );
  const result = await downloadOfflineExploreResults( { } );
  expect( result ).toEqual( { added: 1, total: 2 } );
} );

describe( "offline explore results", ( ) => {
  it( "merges saves without duplicates", async ( ) => {
    expect( await uuids( { } ) ).toHaveLength( 2 );
  } );

  it( "filters by taxon and its descendants", async ( ) => {
    expect( await uuids( { taxon_id: 2 } ) ).toEqual( ["a"] );
    expect( await uuids( { without_taxon_id: [4] } ) ).toEqual( ["a"] );
    expect( await uuids( { iconic_taxa: ["Plantae"] } ) ).toEqual( ["b"] );
  } );

  it( "filters by quality grade, date, month, hour and media", async ( ) => {
    expect( await uuids( { quality_grade: ["needs_id"] } ) ).toEqual( ["b"] );
    expect( await uuids( { d1: "2024-06-01" } ) ).toEqual( ["b"] );
    expect( await uuids( { month: [5] } ) ).toEqual( ["a"] );
    expect( await uuids( { hour: [15] } ) ).toEqual( ["b"] );
    expect( await uuids( { sounds: true } ) ).toEqual( ["b"] );
  } );

  it( "filters by place and area", async ( ) => {
    expect( await uuids( { place_id: 7 } ) ).toEqual( ["a"] );
    expect( await uuids( {
      swlat: 36, swlng: -123, nelat: 38, nelng: -121,
    } ) ).toEqual( ["a"] );
    expect( await uuids( { lat: 37, lng: -122, radius: 5 } ) ).toEqual( ["a"] );
  } );

  it( "filters by user and sorts", async ( ) => {
    expect( await uuids( { not_user_id: 10 } ) ).toEqual( ["b"] );
    expect( await uuids( { order_by: "created_at", order: "asc" } ) ).toEqual( ["a", "b"] );
    expect( await uuids( { } ) ).toEqual( ["b", "a"] );
  } );
} );
