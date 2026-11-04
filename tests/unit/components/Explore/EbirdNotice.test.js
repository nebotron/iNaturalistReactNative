import { screen } from "@testing-library/react-native";
import EbirdNotice from "components/Explore/EbirdNotice";
import React from "react";
import { renderComponent } from "tests/helpers/render";

describe( "EbirdNotice", ( ) => {
  it( "renders nothing when eBird doesn't apply to the search", ( ) => {
    renderComponent( <EbirdNotice ebird={null} /> );
    expect( screen.queryByTestId( "EbirdNotice" ) ).toBeNull( );
  } );

  it( "renders nothing when eBird results are complete", ( ) => {
    renderComponent( <EbirdNotice ebird={{ limits: [], observations: [] }} /> );
    expect( screen.queryByTestId( "EbirdNotice" ) ).toBeNull( );
  } );

  it( "tells the user when results are incomplete", ( ) => {
    renderComponent( <EbirdNotice ebird={{ limits: ["area", "rate"], observations: [] }} /> );
    expect( screen.getByText( "eBird results are incomplete:" ) ).toBeVisible( );
    expect( screen.getByText( /within 50 km/ ) ).toBeVisible( );
    expect( screen.getByText( /Too many eBird searches/ ) ).toBeVisible( );
  } );
} );
