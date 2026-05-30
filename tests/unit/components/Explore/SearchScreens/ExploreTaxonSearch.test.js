import { fireEvent, screen } from "@testing-library/react-native";
import ExploreTaxonSearch from "components/Explore/SearchScreens/ExploreTaxonSearch";
import { ExploreProvider } from "providers/ExploreContext";
import React from "react";
import * as useTaxonSearch from "sharedHooks/useTaxonSearch";
import * as useTaxon from "sharedHooks/useTaxon";
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
    renderComponent(
      <ExploreProvider>
        <ExploreTaxonSearch
          closeModal={jest.fn( )}
          updateTaxonFilters={jest.fn( )}
          taxonFilters={[]}
        />
      </ExploreProvider>,
    );

    const input = screen.getByTestId( "SearchTaxon" );
    fireEvent.changeText( input, "Homo" );

    await screen.findByTestId( `Search.taxa.${mockTaxon.id}` );
    fireEvent.press( screen.getByRole( "link" ) );

    expect( await screen.findByTestId( `Search.taxa.${mockTaxon.id}.checkmark` ) ).toBeTruthy( );
  } );

  it( "applies taxon filters without crashing", async ( ) => {
    const updateTaxonFilters = jest.fn( );
    const closeModal = jest.fn( );

    renderComponent(
      <ExploreProvider>
        <ExploreTaxonSearch
          closeModal={closeModal}
          updateTaxonFilters={updateTaxonFilters}
          taxonFilters={[]}
        />
      </ExploreProvider>,
    );

    fireEvent.press( await screen.findByText( "APPLY FILTERS" ) );

    expect( updateTaxonFilters ).toHaveBeenCalledWith( [] );
    expect( closeModal ).toHaveBeenCalled( );
  } );
} );
