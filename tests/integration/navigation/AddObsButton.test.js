import { BottomSheetModal } from "@gorhom/bottom-sheet";
import { screen, userEvent } from "@testing-library/react-native";
import AddObsButton from "components/AddObsBottomSheet/AddObsButton";
import i18next from "i18next";
import React from "react";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";

const actor = userEvent.setup();

const mockDispatch = jest.fn();
const mockNavigate = jest.fn();
jest.mock( "@react-navigation/native", () => {
  const actualNav = jest.requireActual( "@react-navigation/native" );
  return {
    ...actualNav,
    useNavigation: () => ( {
      dispatch: mockDispatch,
      navigate: mockNavigate,
    } ),
  };
} );

const resetNavigation = ( name, params ) => ( {
  payload: {
    index: 0,
    routes: [{
      name: "NoBottomTabStackNavigator",
      state: {
        index: 0,
        routes: [{
          name,
          params,
        }],
      },
    }],
  },
  type: "RESET",
} );

// The photo importer lives in the tab stack so it keeps the bottom tab bar
const expectNavigationToImporter = ( name, params ) => {
  expect( mockNavigate ).toHaveBeenCalledWith( "TabNavigator", {
    screen: "ObservationsTab",
    params: { screen: name, params },
  } );
};

beforeAll( ( ) => {
  jest.useFakeTimers( );
} );

const longPress = async ( ) => {
  const addObsButton = screen.getByLabelText(
    i18next.t( "Add-observations" ),
  );
  expect( addObsButton ).toBeTruthy( );
  await actor.longPress( addObsButton );
};

const showNoEvidenceOption = ( ) => {
  const noEvidenceButton = screen.getByTestId(
    i18next.t( "observe-without-evidence-button" ),
  );
  expect( noEvidenceButton ).toBeTruthy( );
  return noEvidenceButton;
};

const regularPress = async ( ) => {
  const addObsButton = screen.getByLabelText(
    i18next.t( "Add-observations" ),
  );
  expect( addObsButton ).toBeTruthy( );
  await actor.press( addObsButton );
};

describe( "AddObsButton", ( ) => {
  it( "navigates user to AI camera", async ( ) => {
    renderComponent( <AddObsButton /> );
    await regularPress( );

    expect( mockDispatch ).toHaveBeenCalledWith(
      resetNavigation( "Camera", { camera: "AI", previousScreen: null } ),
    );
  } );

  it( "opens model on long press", async ( ) => {
    renderComponent( <AddObsButton /> );
    await longPress( );
    showNoEvidenceOption( );
  } );
} );

describe( "with advanced user layout", ( ) => {
  beforeEach( ( ) => {
    setStoreStateLayout( {
      isAllAddObsOptionsMode: true,
    } );
    useStore.setState( { groupedPhotos: [] } );
  } );

  it( "navigates user to the photo importer", async ( ) => {
    renderComponent( <AddObsButton /> );
    await regularPress( );

    expectNavigationToImporter( "PhotoLibrary", { previousScreen: null } );
  } );

  it( "returns the user to an import they left rather than starting over", async ( ) => {
    useStore.setState( { groupedPhotos: [{ photos: [{ image: { uri: "file:///a.jpg" } }] }] } );
    renderComponent( <AddObsButton /> );
    await regularPress( );

    expectNavigationToImporter( "GroupPhotos", { previousScreen: null } );
  } );

  it( "opens AddObsBottomSheet on long press", async ( ) => {
    renderComponent( <AddObsButton /> );
    await longPress( );
    showNoEvidenceOption( );
  } );

  it( "navigates user to obs edit with no evidence", async ( ) => {
    renderComponent( <AddObsButton /> );
    await longPress( );

    const noEvidenceButton = showNoEvidenceOption( );
    await actor.press( noEvidenceButton );

    expect( mockDispatch ).toHaveBeenCalledWith(
      resetNavigation( "ObsEdit", { previousScreen: null } ),
    );
  } );

  it( "does not open model on a regular press", async ( ) => {
    const presentSpy = jest.spyOn( BottomSheetModal.prototype, "present" );
    renderComponent( <AddObsButton /> );
    await regularPress( );

    expect( presentSpy ).not.toHaveBeenCalled( );
    presentSpy.mockRestore( );
  } );

  describe( "with advanced AICamera-only setting", ( ) => {
    beforeEach( ( ) => {
      setStoreStateLayout( {
        isDefaultMode: false,
        isAllAddObsOptionsMode: false,
      } );
    } );

    it( "opens model on long press", async ( ) => {
      renderComponent( <AddObsButton /> );
      await longPress( );
      showNoEvidenceOption( );
    } );
  } );
} );
