import { screen, userEvent } from "@testing-library/react-native";
import SavedSearches, { SavedSearchSheets }
  from "components/Explore/ExploreV2/components/SavedSearches";
import initI18next from "i18n/initI18next";
import React from "react";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";
import {
  savedSearch as buildSavedSearch,
  setSavedSearches,
  taxonSubject,
} from "tests/helpers/savedSearch";

const mockOnSelect = jest.fn( );
const mockOnDelete = jest.fn( );
const mockOnSave = jest.fn( );

const savedSearch = ( id, name ) => ( {
  ...buildSavedSearch( { subject: taxonSubject( id ), savedAt: id } ),
  ...( name && { name } ),
} );

const searchFields = ( { key: _key, savedAt: _savedAt, ...search } ) => search;

const renderSection = currentSearch => renderComponent(
  <SavedSearches
    currentSearch={currentSearch}
    onDelete={mockOnDelete}
    onSave={mockOnSave}
    onSelect={mockOnSelect}
  />,
);

const searches = ( ) => useStore.getState( ).exploreSavedSearches.searches;

beforeAll( async ( ) => {
  await initI18next( );
} );

beforeEach( ( ) => {
  setSavedSearches( [] );
  jest.clearAllMocks( );
} );

describe( "SavedSearches", ( ) => {
  it( "says there are none yet when nothing is saved", async ( ) => {
    renderSection( searchFields( savedSearch( 1 ) ) );

    expect( await screen.findByText( "No saved filters yet." ) ).toBeVisible( );
  } );

  it( "lists searches by name and hands the tapped one to the caller", async ( ) => {
    const search = savedSearch( 1, "Cup plants" );
    setSavedSearches( [search] );

    renderSection( searchFields( savedSearch( 2 ) ) );
    await userEvent.setup( ).press( await screen.findByText( "Cup plants" ) );

    expect( mockOnSelect ).toHaveBeenCalledWith( search );
  } );

  it( "marks the saved search matching the current search", async ( ) => {
    const search = savedSearch( 1, "Cup plants" );
    setSavedSearches( [search] );

    renderSection( searchFields( search ) );

    expect( await screen.findByTestId( `SavedSearches.load.${search.key}` ) ).toBeSelected( );
  } );

  it( "overwrites a saved search with the current search", async ( ) => {
    const search = savedSearch( 1, "Cup plants" );
    setSavedSearches( [search] );

    renderSection( searchFields( savedSearch( 2 ) ) );
    await userEvent.setup( ).press(
      await screen.findByTestId( `SavedSearches.overwrite.${search.key}` ),
    );

    expect( searches( ) ).toHaveLength( 1 );
    expect( searches( )[0] ).toMatchObject( { key: search.key, name: "Cup plants" } );
    expect( searches( )[0].subject.taxon.id ).toEqual( 2 );
  } );
} );

describe( "SavedSearchSheets", ( ) => {
  it( "deletes a search once the warning is confirmed", async ( ) => {
    const search = savedSearch( 1, "Cup plants" );
    setSavedSearches( [search] );
    const onCloseDelete = jest.fn( );

    renderComponent(
      <SavedSearchSheets
        currentSearch={searchFields( search )}
        onCloseDelete={onCloseDelete}
        onCloseSave={jest.fn( )}
        searchToDelete={search}
        showSaveSheet={false}
      />,
    );
    await userEvent.setup( ).press( await screen.findByText( "DELETE" ) );

    expect( searches( ) ).toEqual( [] );
    expect( onCloseDelete ).toHaveBeenCalled( );
  } );
} );
