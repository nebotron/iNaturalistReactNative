import { render, screen } from "@testing-library/react-native";
import ReviewButton from "components/ObsDetails/ReviewButton";
import React from "react";

jest.mock( "sharedHooks", ( ) => ( {
  useAuthenticatedMutation: jest.fn( ( ) => ( { mutate: jest.fn( ) } ) ),
  useTranslation: jest.fn( ( ) => ( {
    t: key => key,
  } ) ),
} ) );

describe( "ReviewButton", ( ) => {
  it( "renders for a synced observation when the user is logged in", ( ) => {
    render(
      <ReviewButton
        observation={{
          id: 123,
          uuid: "00000000-0000-0000-0000-000000000001",
          reviewed_by: [],
        }}
        currentUser={{ id: 456 }}
      />,
    );

    expect( screen.getByLabelText( "Mark-as-reviewed" ) ).toBeTruthy( );
  } );

  it( "does not render when the observation has not synced yet", ( ) => {
    render(
      <ReviewButton
        observation={{ reviewed_by: [] }}
        currentUser={{ id: 456 }}
      />,
    );

    expect( screen.queryByLabelText( "Mark-as-reviewed" ) ).toBeNull( );
  } );
} );
