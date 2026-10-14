import identificationOutcome from "components/MyIdentifications/identificationOutcome";

// The user's identification of a genus, made in the middle of the day
const mine = {
  id: 1,
  created_at: "2024-01-01T12:00:00Z",
  user: { id: 99 },
  taxon: { id: 50, ancestor_ids: [1, 10, 50] },
};

const otherIdentification = ( overrides: object ) => ( {
  id: 2,
  created_at: "2024-01-02T12:00:00Z",
  user: { id: 100 },
  taxon: { id: 50, ancestor_ids: [1, 10, 50] },
  ...overrides,
} );

describe( "identificationOutcome", ( ) => {
  it( "reports nothing when no one else has weighed in", ( ) => {
    expect( identificationOutcome( mine, [mine] ) ).toEqual( {
      agreed: false,
      disagreed: false,
    } );
  } );

  it( "reports agreement for a later identification of the same taxon", ( ) => {
    expect( identificationOutcome( mine, [mine, otherIdentification( {} )] ) ).toEqual( {
      agreed: true,
      disagreed: false,
    } );
  } );

  it( "reports agreement for a later identification of a descendant taxon", ( ) => {
    const finer = otherIdentification( {
      taxon: { id: 51, ancestor_ids: [1, 10, 50, 51] },
    } );
    expect( identificationOutcome( mine, [mine, finer] ).agreed ).toBe( true );
  } );

  it( "reports disagreement for a later identification on another branch", ( ) => {
    const elsewhere = otherIdentification( {
      taxon: { id: 60, ancestor_ids: [1, 10, 60] },
    } );
    expect( identificationOutcome( mine, [mine, elsewhere] ) ).toEqual( {
      agreed: false,
      disagreed: true,
    } );
  } );

  it( "reports disagreement when the disagreement flag is set", ( ) => {
    const explicit = otherIdentification( {
      disagreement: true,
      taxon: { id: 10, ancestor_ids: [1, 10] },
    } );
    expect( identificationOutcome( mine, [mine, explicit] ).disagreed ).toBe( true );
  } );

  it( "reports nothing for a coarser identification without the disagreement flag", ( ) => {
    const coarser = otherIdentification( {
      taxon: { id: 10, ancestor_ids: [1, 10] },
    } );
    expect( identificationOutcome( mine, [mine, coarser] ) ).toEqual( {
      agreed: false,
      disagreed: false,
    } );
  } );

  it( "ignores identifications made before the user's", ( ) => {
    const earlier = otherIdentification( {
      created_at: "2023-12-31T12:00:00Z",
      taxon: { id: 60, ancestor_ids: [1, 10, 60] },
    } );
    expect( identificationOutcome( mine, [earlier, mine] ) ).toEqual( {
      agreed: false,
      disagreed: false,
    } );
  } );

  it( "ignores the user's own later identifications", ( ) => {
    const ownCorrection = otherIdentification( {
      user: { id: 99 },
      taxon: { id: 60, ancestor_ids: [1, 10, 60] },
    } );
    expect( identificationOutcome( mine, [mine, ownCorrection] ) ).toEqual( {
      agreed: false,
      disagreed: false,
    } );
  } );

  it( "ignores withdrawn and hidden identifications", ( ) => {
    const withdrawn = otherIdentification( { current: false } );
    const hidden = otherIdentification( { id: 3, hidden: true } );
    expect( identificationOutcome( mine, [mine, withdrawn, hidden] ) ).toEqual( {
      agreed: false,
      disagreed: false,
    } );
  } );

  it( "reports both when one identifier agreed and another disagreed", ( ) => {
    const agreeing = otherIdentification( {} );
    const disagreeing = otherIdentification( {
      id: 3,
      user: { id: 101 },
      taxon: { id: 60, ancestor_ids: [1, 10, 60] },
    } );
    expect( identificationOutcome( mine, [mine, agreeing, disagreeing] ) ).toEqual( {
      agreed: true,
      disagreed: true,
    } );
  } );
} );
