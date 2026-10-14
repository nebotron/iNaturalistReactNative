import { filterOfflineObservations } from "sharedHelpers/offlineExploreResults";

const bird = {
  uuid: "a",
  created_at: "2024-05-02T10:00:00Z",
  observed_on: "2024-05-01",
  time_observed_at: "2024-05-01T07:30:00-07:00",
  quality_grade: "research",
  taxon: { id: 3, ancestor_ids: [1, 2, 3], iconic_taxon_name: "Aves" },
  observation_photos: [{}],
  user: { id: 10 },
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
const observations = [bird, plant];
const uuids = ( params: Record<string, unknown> ) => filterOfflineObservations(
  observations as never,
  params,
).map( o => o.uuid );

describe( "filterOfflineObservations", ( ) => {
  it( "filters by taxon and its descendants", ( ) => {
    expect( uuids( { taxon_id: 2 } ) ).toEqual( ["a"] );
    expect( uuids( { without_taxon_id: [4] } ) ).toEqual( ["a"] );
  } );

  it( "filters by quality grade, date, month, hour and media", ( ) => {
    expect( uuids( { quality_grade: ["needs_id"] } ) ).toEqual( ["b"] );
    expect( uuids( { d1: "2024-06-01" } ) ).toEqual( ["b"] );
    expect( uuids( { month: [5] } ) ).toEqual( ["a"] );
    expect( uuids( { hour: [15] } ) ).toEqual( ["b"] );
    expect( uuids( { sounds: true } ) ).toEqual( ["b"] );
  } );

  it( "filters by user and sorts", ( ) => {
    expect( uuids( { not_user_id: 10 } ) ).toEqual( ["b"] );
    expect( uuids( { order_by: "created_at", order: "asc" } ) ).toEqual( ["a", "b"] );
    expect( uuids( { } ) ).toEqual( ["b", "a"] );
  } );
} );
