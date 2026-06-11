import { fireEvent, screen } from "@testing-library/react-native";
import ExploreTaxonSearch from "components/Explore/SearchScreens/ExploreTaxonSearch";
import { ExploreProvider } from "providers/ExploreContext";
import React from "react";
import * as useTaxon from "sharedHooks/useTaxon";
import * as useTaxonSearch from "sharedHooks/useTaxonSearch";
import factory from "tests/factory";
import { renderComponent } from "tests/helpers/render";

jest.mock(
  "components/SharedComponents/ViewWrapper",
  () => function MockViewWrapper( props ) {
    const MockName = "mock-view-no-footer";
    return (
      // eslint-disable-next-line react/jsx-props-no-spreading
      <MockName {...props} testID={MockName}>
        {props.children}
      </MockName>
    );
  },
);

const mockTaxon = factory( "RemoteTaxon" );

describe( "ExploreTaxonSearch", ( ) => {
  beforeEach( ( ) => {
    jest.spyOn( useTaxonSearch, "default" ).mockImplementation( () => ( {
      taxa: [mockTaxon],
      isLoading: false,
      isLocal: false,
    } ) );
    jest.spyOn( useTaxon, "default" ).mockImplementation( () => ( {
      taxon: mockTaxon,
    } ) );
  } );

  it( "selects a taxon without crashing", async ( ) => {
    const updateTaxonFilters = jest.fn( );
    renderComponent(
      <ExploreProvider>
        <ExploreTaxonSearch
          closeModal={jest.fn( )}
          updateTaxonFilters={updateTaxonFilters}
          taxonFilters={[]}
        />
      </ExploreProvider>,
    );

    const input = screen.getByTestId( "SearchTaxon" );
    fireEvent.changeText( input, "Homo" );

    await screen.findByTestId( `Search.taxa.${mockTaxon.id}` );
    fireEvent.press( screen.getByRole( "link" ) );

    expect( updateTaxonFilters ).toHaveBeenCalledWith(
      expect.arrayContaining( [
        expect.objectContaining( {
          taxon: expect.objectContaining( { id: mockTaxon.id } ),
        } ),
      ] ),
    );
  } );
} );
