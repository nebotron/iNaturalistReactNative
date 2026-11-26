import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { INatApiError } from "api/error";
import { faveObservation } from "api/observations";
import FaveButton from "components/ObsDetails/FaveButton";
import i18next from "i18next";
import React from "react";
import { Alert } from "react-native";
import factory from "tests/factory";
import { renderComponent } from "tests/helpers/render";

jest.mock( "api/observations", ( ) => ( {
  faveObservation: jest.fn( ),
  unfaveObservation: jest.fn( ),
} ) );

describe( "FaveButton", () => {
  it( "should survive no currentUser", ( ) => {
    expect(
      ( ) => renderComponent(
        <FaveButton
          observation={factory( "LocalObservation" )}
        />,
      ),
    ).not.toThrow( );
  } );

  it( "should survive no currentUser for an observation w/ existing votes", ( ) => {
    const observation = factory( "RemoteObservation", {
      votes: [factory( "RemoteVote" )],
    } );
    expect(
      ( ) => renderComponent(
        <FaveButton
          observation={observation}
        />,
      ),
    ).not.toThrow( );
  } );

  it( "shows readable text when the API error message is an object", async ( ) => {
    jest.spyOn( Alert, "alert" ).mockImplementation( ( ) => undefined );
    faveObservation.mockRejectedValue( new INatApiError( {
      status: 422,
      errors: [{ message: { error: "You can't fave this" } }],
    }, 422 ) );
    const currentUser = factory( "LocalUser" );
    renderComponent(
      <FaveButton
        observation={factory( "RemoteObservation", { votes: [] } )}
        currentUser={currentUser}
      />,
    );
    fireEvent.press( screen.getByLabelText( i18next.t( "Add-favorite" ) ) );
    await waitFor( ( ) => {
      expect( Alert.alert ).toHaveBeenCalledWith(
        i18next.t( "Error-title" ),
        "You can't fave this",
        expect.anything( ),
        expect.anything( ),
      );
    } );
  } );
} );
