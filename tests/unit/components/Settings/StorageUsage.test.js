import { screen } from "@testing-library/react-native";
import StorageUsage, { formatGB } from "components/Settings/StorageUsage";
import React from "react";
import { renderComponent } from "tests/helpers/render";

jest.mock( "sharedHelpers/storageBreakdown", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => Promise.resolve( {
    categories: [
      { category: "photos", bytes: 3 * 1073741824 },
      { category: "cache", bytes: 1073741824 },
    ],
    totalBytes: 4 * 1073741824,
  } ) ),
} ) );

describe( "StorageUsage", ( ) => {
  it( "shows the total and each category's size and share in GB", async ( ) => {
    renderComponent( <StorageUsage /> );
    expect( await screen.findByText( "4.00 GB" ) ).toBeVisible( );
    expect( screen.queryByText( /free on this device/ ) ).toBeNull( );
    expect( screen.getByText( "Observation photos" ) ).toBeVisible( );
    expect( screen.getByText( "3.00 GB" ) ).toBeVisible( );
    expect( screen.getByText( "75%" ) ).toBeVisible( );
    expect( screen.getByText( "Cache" ) ).toBeVisible( );
    expect( screen.getByText( "1.00 GB" ) ).toBeVisible( );
    expect( screen.getByText( "25%" ) ).toBeVisible( );
  } );

  it( "shows small amounts with two decimals of GB", ( ) => {
    expect( formatGB( 5 * 1048576 ) ).toBe( "0.00 GB" );
    expect( formatGB( 1610612736 ) ).toBe( "1.50 GB" );
    expect( formatGB( 12.345 * 1073741824 ) ).toBe( "12.35 GB" );
  } );
} );
