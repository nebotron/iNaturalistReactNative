import relativeSavedSearch from "components/Explore/ExploreV2/helpers/relativeSavedSearch";
import { defaultExploreV2Filters } from "providers/ExploreV2Context";
import { savedSearch } from "tests/helpers/savedSearch";

const withDates = ( filters, extra = {} ) => ( {
  ...savedSearch( { filters: { ...defaultExploreV2Filters, ...filters } } ),
  ...extra,
} );

const tomorrow = new Date( 2026, 10, 11, 9 );

describe( "relativeSavedSearch", ( ) => {
  it( "moves a search saved for today to the day it's opened", ( ) => {
    const search = withDates( { observed_on: "2026-11-10" }, { datesAsOf: "2026-11-10" } );

    expect( relativeSavedSearch( search, tomorrow ).filters.observed_on ).toEqual( "2026-11-11" );
  } );

  it( "keeps the length of observed and uploaded ranges", ( ) => {
    const search = withDates( {
      d1: "2026-10-31",
      d2: "2026-11-10",
      created_d1: "2026-11-09",
      created_d2: "2026-11-10",
    }, { datesAsOf: "2026-11-10" } );

    const { filters } = relativeSavedSearch( search, new Date( 2026, 11, 1 ) );

    expect( filters.d1 ).toEqual( "2026-11-21" );
    expect( filters.d2 ).toEqual( "2026-12-01" );
    expect( filters.created_d1 ).toEqual( "2026-11-30" );
    expect( filters.created_d2 ).toEqual( "2026-12-01" );
  } );

  it( "leaves a search opened the day it was saved alone", ( ) => {
    const search = withDates( { observed_on: "2026-11-10" }, { datesAsOf: "2026-11-11" } );

    expect( relativeSavedSearch( search, tomorrow ) ).toBe( search );
  } );

  it( "anchors searches saved before datesAsOf existed to when they were saved", ( ) => {
    const search = withDates(
      { observed_on: "2026-11-10" },
      { savedAt: new Date( 2026, 10, 10, 20 ).getTime( ) },
    );

    expect( relativeSavedSearch( search, tomorrow ).filters.observed_on ).toEqual( "2026-11-11" );
  } );

  it( "leaves searches without dates alone", ( ) => {
    const search = withDates( {}, { datesAsOf: "2026-01-01" } );

    expect( relativeSavedSearch( search, tomorrow ) ).toBe( search );
  } );
} );
