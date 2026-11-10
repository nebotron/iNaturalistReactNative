import { screen } from "@testing-library/react-native";
import StorageUsage from "components/Settings/StorageUsage";
import React from "react";
import { renderComponent } from "tests/helpers/render";

jest.mock( "sharedHelpers/storageBreakdown", ( ) => ( {
  __esModule: true,
  default: jest.fn( ( ) => Promise.resolve( {
    categories: [
      { category: "photos", bytes: 3 * 1048576 },
      { category: "cache", bytes: 1048576 },
    ],
    totalBytes: 4 * 1048576,
    freeDiskBytes: 2 * 1073741824,
  } ) ),
} ) );

describe( "StorageUsage", ( ) => {
  it( "shows the total, free space and each category's share", async ( ) => {
    renderComponent( <StorageUsage /> );
    expect( await screen.findByText( "4.00 MB" ) ).toBeVisible( );
    expect( screen.getByText( "2.00 GB free on this device" ) ).toBeVisible( );
    expect( screen.getByText( "Observation photos" ) ).toBeVisible( );
    expect( screen.getByText( "3.00 MB" ) ).toBeVisible( );
    expect( screen.getByText( "75%" ) ).toBeVisible( );
    expect( screen.getByText( "Cache" ) ).toBeVisible( );
    expect( screen.getByText( "25%" ) ).toBeVisible( );
  } );
} );
