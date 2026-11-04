import { resultToSubject } from "components/Explore/ExploreV2/helpers/universalSearchSubject";

const USER_RESULT = {
  type: "user",
  user: {
    id: 7,
    login: "seth_msp",
    icon_url: "https://example.com/u.jpg",
    observations_count: 5,
  },
};

const PROJECT_RESULT = {
  type: "project",
  project: {
    id: 9,
    title: "InverteFest",
    project_type: "collection",
    rule_preferences: [],
    icon: "https://example.com/p.jpg",
  },
};

const TAXON_RESULT = {
  type: "taxon",
  taxon: {
    id: 12,
    name: "Eumyias thalassinus",
    preferred_common_name: "Verditer Flycatcher",
    iconic_taxon_name: "Aves",
    default_photo: { url: "https://example.com/t.jpg" },
  },
};

const RESULTS = [USER_RESULT, PROJECT_RESULT, TAXON_RESULT];

describe( "resultToSubject", ( ) => {
  it.each( RESULTS )(
    "keeps a $type result's fields in the subject",
    result => {
      expect( resultToSubject( result ) ).toEqual( result );
    },
  );

  it( "drops result fields the subject does not carry", ( ) => {
    const subject = resultToSubject( {
      type: "taxon",
      taxon: {
        ...TAXON_RESULT.taxon,
        ancestor_ids: [1, 2],
        wikipedia_url: "https://example.com/w",
      },
    } );

    expect( subject.taxon.ancestor_ids ).toBeUndefined( );
    expect( subject.taxon.wikipedia_url ).toBeUndefined( );
  } );
} );
