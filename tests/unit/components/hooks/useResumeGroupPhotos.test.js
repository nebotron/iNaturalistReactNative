import { renderHook } from "@testing-library/react-native";
import useResumeGroupPhotos from "components/hooks/useResumeGroupPhotos";
import useStore from "stores/useStore";

const mockNavigate = jest.fn();
jest.mock( "@react-navigation/native", () => ( {
  ...jest.requireActual( "@react-navigation/native" ),
  useNavigation: () => ( { navigate: mockNavigate } ),
} ) );

let mockOnboardingShown = true;
jest.mock( "sharedHelpers/installData", () => ( {
  ...jest.requireActual( "sharedHelpers/installData" ),
  useOnboardingShown: () => [mockOnboardingShown],
} ) );

const groupPhoto = uri => ( { photos: [{ image: { uri } }] } );

describe( "useResumeGroupPhotos", () => {
  beforeEach( () => {
    jest.clearAllMocks();
    mockOnboardingShown = true;
    useStore.setState( { groupedPhotos: [] } );
    jest.spyOn( useStore.persist, "hasHydrated" ).mockReturnValue( true );
  } );

  it( "navigates to Group Photos when there is saved progress", () => {
    useStore.setState( { groupedPhotos: [groupPhoto( "file:///a.jpg" )] } );

    renderHook( () => useResumeGroupPhotos() );

    expect( mockNavigate ).toHaveBeenCalledWith(
      "NoBottomTabStackNavigator",
      { screen: "GroupPhotos" },
    );
  } );

  it( "does not navigate when there is no saved progress", () => {
    renderHook( () => useResumeGroupPhotos() );

    expect( mockNavigate ).not.toHaveBeenCalled();
  } );

  it( "does not navigate before onboarding has been shown", () => {
    mockOnboardingShown = false;
    useStore.setState( { groupedPhotos: [groupPhoto( "file:///a.jpg" )] } );

    renderHook( () => useResumeGroupPhotos() );

    expect( mockNavigate ).not.toHaveBeenCalled();
  } );

  it( "waits for store hydration before resuming", () => {
    let finishHydration;
    jest.spyOn( useStore.persist, "hasHydrated" ).mockReturnValue( false );
    jest.spyOn( useStore.persist, "onFinishHydration" ).mockImplementation( cb => {
      finishHydration = cb;
      return () => undefined;
    } );
    useStore.setState( { groupedPhotos: [groupPhoto( "file:///a.jpg" )] } );

    renderHook( () => useResumeGroupPhotos() );
    expect( mockNavigate ).not.toHaveBeenCalled();

    finishHydration();
    expect( mockNavigate ).toHaveBeenCalledWith(
      "NoBottomTabStackNavigator",
      { screen: "GroupPhotos" },
    );
  } );
} );
