import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import inatjs from "inaturalistjs";

jest.mock( "inaturalistjs" );

describe( "fetchUnviewedObservationUpdatesCount", ( ) => {
  afterEach( ( ) => {
    inatjs.observations.updates.mockReset( );
  } );

  it( "leaves out updates whose comment or identification is gone", async ( ) => {
    inatjs.observations.updates.mockResolvedValue( {
      total_results: 3,
      results: [
        { id: 1, comment: { id: 10 } },
        { id: 2, identification: { id: 20 } },
        // The notifications list hides this one, and it can't be marked viewed
        { id: 3 },
      ],
    } );
    const count = await fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      { api_token: "test-jwt" },
    );
    expect( count ).toEqual( 2 );
    expect( inatjs.observations.updates ).toHaveBeenCalledWith(
      expect.objectContaining( { observations_by: "owner", viewed: false } ),
      { api_token: "test-jwt" },
    );
  } );

  it( "returns 0 without a token, without asking the server", async ( ) => {
    const count = await fetchUnviewedObservationUpdatesCount( {}, {} );
    expect( count ).toEqual( 0 );
    expect( inatjs.observations.updates ).not.toHaveBeenCalled( );
  } );
} );
