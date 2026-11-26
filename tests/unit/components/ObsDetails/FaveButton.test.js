import { faker } from "@faker-js/faker";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { INatApiError } from "api/error";
import { faveObservation } from "api/observations";
import FaveButton from "components/ObsDetails/FaveButton";
import i18next from "i18next";
import React from "react";
import { Alert } from "react-native";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import factory from "tests/factory";
import { renderComponent } from "tests/helpers/render";
import withRetry from "uploaders/utils/retry";

jest.mock( "api/observations", ( ) => ( {
  faveObservation: jest.fn( ),
  unfaveObservation: jest.fn( ),
} ) );

jest.mock( "uploaders/utils/retry", ( ) => jest.fn( fn => fn( ) ) );

const tapFaveOnSyncedObservation = async syncedAt => {
  faveObservation.mockResolvedValue( {} );
  const uuid = faker.string.uuid( );
  safeRealmWrite( global.realm, ( ) => {
    global.realm.create( "Observation", {
      uuid,
      id: faker.number.int( ),
      _created_at: syncedAt,
      _updated_at: syncedAt,
      _synced_at: syncedAt,
    } );
  } );
  renderComponent(
    <FaveButton
      observation={factory( "RemoteObservation", { uuid, votes: [] } )}
      currentUser={factory( "LocalUser" )}
    />,
  );
  fireEvent.press( screen.getByLabelText( i18next.t( "Add-favorite" ) ) );
  await waitFor( ( ) => expect( faveObservation ).toHaveBeenCalled( ) );
};

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

  describe( "retrying a 404", ( ) => {
    beforeEach( ( ) => {
      withRetry.mockClear( );
      faveObservation.mockClear( );
    } );

    it( "retries for an observation that just finished uploading", async ( ) => {
      await tapFaveOnSyncedObservation( new Date( ) );
      expect( withRetry ).toHaveBeenCalledWith(
        expect.any( Function ),
        { alsoRetryStatuses: [404] },
      );
    } );

    it( "does not retry for an observation uploaded long ago", async ( ) => {
      await tapFaveOnSyncedObservation( new Date( Date.now( ) - 60 * 60 * 1000 ) );
      expect( withRetry ).not.toHaveBeenCalled( );
    } );
  } );
} );
