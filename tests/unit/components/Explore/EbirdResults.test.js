import { screen } from "@testing-library/react-native";
import EbirdResults from "components/Explore/EbirdResults";
import React from "react";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const mockEbird = jest.fn( );
jest.mock( "components/Explore/hooks/useEbirdObservations", ( ) => ( {
  __esModule: true,
  default: ( ) => mockEbird( ),
} ) );

const observation = {
  comName: "Green Heron",
  howMany: 2,
  locName: "Nisqually NWR",
  obsDt: "2026-10-12 09:00",
  speciesCode: "grnher",
  subId: "S1",
};

describe( "EbirdResults", ( ) => {
  beforeEach( ( ) => {
    useStore.getState( ).layout.setEbirdEnabled( true );
  } );

  it( "renders nothing until eBird sightings are included", ( ) => {
    useStore.getState( ).layout.setEbirdEnabled( false );
    mockEbird.mockReturnValue( { limits: [], observations: [observation] } );
    renderComponent( <EbirdResults params={{}} /> );
    expect( screen.queryByTestId( "EbirdResults" ) ).toBeNull( );
  } );

  it( "renders nothing when eBird doesn't apply to the search", ( ) => {
    mockEbird.mockReturnValue( null );
    renderComponent( <EbirdResults params={{}} /> );
    expect( screen.queryByTestId( "EbirdResults" ) ).toBeNull( );
  } );

  it( "shows sightings without a warning when results are complete", ( ) => {
    mockEbird.mockReturnValue( { limits: [], observations: [observation] } );
    renderComponent( <EbirdResults params={{}} /> );
    expect( screen.getByText( "1 recent eBird sighting" ) ).toBeVisible( );
    expect( screen.getByText( "Nisqually NWR" ) ).toBeVisible( );
    expect( screen.queryByTestId( "EbirdResults.limits" ) ).toBeNull( );
  } );

  it( "tells the user when results are incomplete", ( ) => {
    mockEbird.mockReturnValue( { limits: ["area", "rate"], observations: [observation] } );
    renderComponent( <EbirdResults params={{}} /> );
    expect( screen.getByText( "eBird results are incomplete:" ) ).toBeVisible( );
    expect( screen.getByText( /within 50 km/ ) ).toBeVisible( );
    expect( screen.getByText( /Too many eBird searches/ ) ).toBeVisible( );
  } );
} );
