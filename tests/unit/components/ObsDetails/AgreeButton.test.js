import { fireEvent, render, screen } from "@testing-library/react-native";
import { createIdentification, updateIdentification } from "api/identifications";
import AgreeButton from "components/ObsDetails/AgreeButton";
import React from "react";

jest.mock( "api/identifications", ( ) => ( {
  createIdentification: jest.fn( ),
  updateIdentification: jest.fn( ),
} ) );

jest.mock( "sharedHooks", ( ) => ( {
  useAuthenticatedMutation: jest.fn( mutationFn => ( {
    mutate: params => mutationFn( params, {} ),
  } ) ),
  useTranslation: jest.fn( ( ) => ( {
    t: key => key,
  } ) ),
} ) );

describe( "AgreeButton", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "renders when the user can agree with the current taxon", ( ) => {
    render(
      <AgreeButton
        observation={{
          uuid: "00000000-0000-0000-0000-000000000001",
          user: { id: 1 },
          taxon: { id: 10, is_active: true, rank_level: 10 },
          identifications: [],
        }}
        currentUser={{ id: 2 }}
        directAgree
      />,
    );

    expect( screen.getByLabelText( "Agree" ) ).toBeTruthy( );
  } );

  it( "stays visible and withdraws when the user already agreed", ( ) => {
    render(
      <AgreeButton
        observation={{
          uuid: "00000000-0000-0000-0000-000000000001",
          user: { id: 1 },
          taxon: { id: 10, is_active: true, rank_level: 10 },
          identifications: [{
            current: true,
            uuid: "ident-uuid",
            user: { id: 2 },
            taxon: { id: 10 },
          }],
        }}
        currentUser={{ id: 2 }}
        directAgree
      />,
    );

    fireEvent.press( screen.getByLabelText( "Withdraw" ) );
    expect( updateIdentification ).toHaveBeenCalledWith( {
      id: "ident-uuid",
      identification: { current: false },
    }, {} );
  } );

  it( "agrees when the user has not agreed yet", ( ) => {
    render(
      <AgreeButton
        observation={{
          uuid: "00000000-0000-0000-0000-000000000001",
          user: { id: 1 },
          taxon: { id: 10, is_active: true, rank_level: 10 },
          identifications: [],
        }}
        currentUser={{ id: 2 }}
        directAgree
      />,
    );

    fireEvent.press( screen.getByLabelText( "Agree" ) );
    expect( createIdentification ).toHaveBeenCalledWith( {
      identification: {
        observation_id: "00000000-0000-0000-0000-000000000001",
        taxon_id: 10,
      },
    }, {} );
  } );

  it( "does not render for genus-level identifications", ( ) => {
    render(
      <AgreeButton
        observation={{
          uuid: "00000000-0000-0000-0000-000000000001",
          user: { id: 1 },
          taxon: { id: 10, is_active: true, rank_level: 20 },
          identifications: [],
        }}
        currentUser={{ id: 2 }}
        directAgree
      />,
    );

    expect( screen.queryByLabelText( "Agree" ) ).toBeFalsy( );
  } );

  it( "renders for subspecies-level identifications", ( ) => {
    render(
      <AgreeButton
        observation={{
          uuid: "00000000-0000-0000-0000-000000000001",
          user: { id: 1 },
          taxon: { id: 10, is_active: true, rank_level: 5 },
          identifications: [],
        }}
        currentUser={{ id: 2 }}
        directAgree
      />,
    );

    expect( screen.getByLabelText( "Agree" ) ).toBeTruthy( );
  } );
} );
