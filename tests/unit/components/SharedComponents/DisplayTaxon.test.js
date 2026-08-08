import { screen } from "@testing-library/react-native";
import { DisplayTaxon } from "components/SharedComponents";
import React from "react";
import factory from "tests/factory";
import { renderComponent } from "tests/helpers/render";

const mockTaxon = factory( "RemoteTaxon", {
  name: "Aves",
  preferred_common_name: "Birds",
  default_photo: {
    url: "",
  },
} );

const taxonWithIconicTaxonPhoto = factory( "LocalTaxon", {
  name: "Pavo cristatus",
  preferred_common_name: "Peafowl",
  iconic_taxon_name: "Aves",
  default_photo: {
    url: "some url",
  },
} );

describe( "DisplayTaxon", () => {
  it( "should be accessible", () => {
    // Disabled during the update to RN 0.78
    // expect( <DisplayTaxon taxon={mockTaxon} handlePress={( ) => undefined} /> )
    //   .toBeAccessible( );
  } );

  it( "displays an iconic taxon icon when no photo is available", () => {
    renderComponent( <DisplayTaxon taxon={mockTaxon} handlePress={( ) => undefined} /> );

    expect( screen.getByTestId( "IconicTaxonName.iconicTaxonIcon" ) );
  } );

  it( "displays an iconic taxon photo when no taxon photo is available", () => {
    renderComponent(
      <DisplayTaxon
        taxon={taxonWithIconicTaxonPhoto}
        handlePress={( ) => undefined}
      />,
    );

    // CachedImage puts the testID on a wrapper and the loader underneath. The
    // remote loader names it `url` and the local one `uri`; this fixture's
    // photo isn't an http URL, so it takes the local path.
    // eslint-disable-next-line testing-library/no-node-access
    const { source } = screen.getByTestId( "DisplayTaxon.image" ).children[0].props;
    expect( source.url || source.uri )
      .toStrictEqual( taxonWithIconicTaxonPhoto?.default_photo?.url );
  } );

  it( "displays 50% opacity when taxon id is withdrawn", () => {
    renderComponent(
      <DisplayTaxon
        taxon={taxonWithIconicTaxonPhoto}
        handlePress={( ) => undefined}
        withdrawn
      />,
    );

    expect(
      screen.getByTestId( "DisplayTaxon.image" ),
    ).toHaveStyle( { opacity: 0.5 } );
  } );
} );
