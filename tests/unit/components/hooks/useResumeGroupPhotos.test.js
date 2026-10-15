import { renderHook } from "@testing-library/react-native";
import useResumeGroupPhotos from "components/hooks/useResumeGroupPhotos";
import useStore from "stores/useStore";

const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
let mockIsReady = true;
jest.mock( "navigation/navigationUtils", () => ( {
  navigationRef: {
    isReady: () => mockIsReady,
    navigate: ( ...args ) => mockNavigate( ...args ),
    dispatch: ( ...args ) => mockDispatch( ...args ),
  },
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
    mockIsReady = true;
    useStore.setState( { groupedPhotos: [], groupCropResume: null } );
    jest.spyOn( useStore.persist, "hasHydrated" ).mockReturnValue( true );
  } );

  it( "navigates to Group Photos when there is saved progress", () => {
    useStore.setState( { groupedPhotos: [groupPhoto( "file:///a.jpg" )] } );

    renderHook( () => useResumeGroupPhotos() );

    // Resumes inside the My Observations tab so the import keeps the tab bar
    expect( mockNavigate ).toHaveBeenCalledWith( "TabNavigator", {
      screen: "ObservationsTab",
      params: { screen: "GroupPhotos" },
    } );
  } );

  it( "reopens the cropper on top of Group Photos when a crop was left part way", () => {
    useStore.setState( {
      groupedPhotos: [groupPhoto( "file:///a.jpg" ), groupPhoto( "file:///b.jpg" )],
      groupCropResume: {
        imageUri: "file:///a.jpg",
        pendingImageUris: ["file:///b.jpg"],
        cropImport: false,
        skipUris: [],
      },
    } );

    renderHook( () => useResumeGroupPhotos() );

    expect( mockNavigate ).not.toHaveBeenCalled();
    const { payload } = mockDispatch.mock.calls[0][0];
    const tabStack = payload.routes[0].state.routes[0];
    expect( tabStack.name ).toBe( "ObservationsTab" );
    expect( tabStack.state.routes.map( route => route.name ) )
      .toEqual( ["ObsList", "GroupPhotos", "ImageCropEditor"] );
    expect( tabStack.state.routes[2].params ).toEqual( {
      context: "groupPhotos",
      imageUri: "file:///a.jpg",
      pendingImageUris: ["file:///b.jpg"],
    } );
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

  it( "does not navigate before the navigator is ready", () => {
    mockIsReady = false;
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
    // Resumes inside the My Observations tab so the import keeps the tab bar
    expect( mockNavigate ).toHaveBeenCalledWith( "TabNavigator", {
      screen: "ObservationsTab",
      params: { screen: "GroupPhotos" },
    } );
  } );
} );
