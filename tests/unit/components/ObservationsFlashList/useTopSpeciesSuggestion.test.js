import { renderHook } from "@testing-library/react-native";
import useTopSpeciesSuggestion from
  "components/ObservationsFlashList/hooks/useTopSpeciesSuggestion";

let mockResults = [];

jest.mock( "sharedHooks", ( ) => ( {
  useCurrentUser: ( ) => ( { id: 1 } ),
  useAuthenticatedQuery: ( ) => ( { data: { results: mockResults } } ),
} ) );
jest.mock( "components/Suggestions/helpers/flattenUploadParams", ( ) => jest.fn( ) );
jest.mock( "api/computerVision", ( ) => jest.fn( ) );

const genusObservation = {
  id: 10,
  taxon: { id: 100, rank: "genus", rank_level: 20 },
  user: { id: 2 },
};

describe( "useTopSpeciesSuggestion", ( ) => {
  it( "suggests a confident CV species that descends from the broad taxon", ( ) => {
    const species = {
      id: 101, rank: "species", rank_level: 10, ancestor_ids: [1, 100, 101],
    };
    mockResults = [{ combined_score: 95, taxon: species }];
    const { result } = renderHook(
      ( ) => useTopSpeciesSuggestion( genusObservation, "https://example.com/1.jpg" ),
    );
    expect( result.current ).toEqual( species );
  } );

  it( "keeps the broad taxon when the CV species is outside it", ( ) => {
    mockResults = [{
      combined_score: 95,
      taxon: {
        id: 201, rank: "species", rank_level: 10, ancestor_ids: [1, 200, 201],
      },
    }];
    const { result } = renderHook(
      ( ) => useTopSpeciesSuggestion( genusObservation, "https://example.com/1.jpg" ),
    );
    expect( result.current ).toBeUndefined( );
  } );
} );
