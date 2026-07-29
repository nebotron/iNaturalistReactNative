import { screen } from "@testing-library/react-native";
import IdentifyView from "components/Explore/IdentifyView";
import React from "react";
import { Image } from "react-native";
import { renderComponent } from "tests/helpers/render";

const mockObservations = [];

jest.mock( "components/Explore/hooks/useInfiniteExploreScroll", ( ) => ( {
  __esModule: true,
  default: ( ) => ( {
    observations: mockObservations,
    totalResults: mockObservations.length,
    fetchNextPage: jest.fn( ),
    isLoading: false,
  } ),
} ) );

// Subject detection and CV scoring hit native modules / the network and aren't
// what these tests are about.
jest.mock( "sharedHelpers/useSubjectDetectionForUri", ( ) => ( {
  __esModule: true,
  // null means detection hasn't resolved, so the photo isn't auto-framed
  default: ( ) => null,
  preloadSubjectDetectionForUri: jest.fn( ),
} ) );
jest.mock(
  "components/ObservationsFlashList/hooks/useTopSpeciesSuggestion",
  ( ) => ( { __esModule: true, default: ( ) => undefined } ),
);

const renderIdentifyView = ( ) => renderComponent(
  <IdentifyView
    canFetch
    queryParams={{}}
    handleUpdateCount={jest.fn( )}
  />,
);

describe( "IdentifyView", ( ) => {
  beforeEach( ( ) => {
    mockObservations.length = 0;
    // Image.prefetch returns undefined under the react-native jest preset, but
    // the view chains .catch() off the promise it returns for real
    jest.spyOn( Image, "prefetch" ).mockResolvedValue( true );
  } );

  it( "shows the photo count for an observation with photos", ( ) => {
    mockObservations.push( {
      uuid: "with-photos",
      observation_photos: [
        { photo: { url: "https://inaturalist.org/photos/1/square.jpg" } },
        { photo: { url: "https://inaturalist.org/photos/2/square.jpg" } },
      ],
    } );
    renderIdentifyView( );

    expect( screen.getByText( "1/2" ) ).toBeVisible( );
    expect( screen.queryByTestId( "IdentifyView.noEvidence" ) ).toBeNull( );
  } );

  it( "plays the sound of an observation with no photos", ( ) => {
    mockObservations.push( {
      uuid: "sound-only",
      observation_photos: [],
      observation_sounds: [
        { sound: { file_url: "https://inaturalist.org/sounds/1.wav" } },
      ],
    } );
    renderIdentifyView( );

    // The sound counts as the one piece of media, and it's playable...
    expect( screen.getByText( "1/1" ) ).toBeVisible( );
    expect( screen.getByLabelText( "Play" ) ).toBeVisible( );
    // ...so this is not treated as an observation with no evidence.
    expect( screen.queryByTestId( "IdentifyView.noEvidence" ) ).toBeNull( );
  } );

  it( "marks an observation with no photos and no sounds as having no evidence", ( ) => {
    mockObservations.push( {
      uuid: "no-evidence",
      observation_photos: [],
      observation_sounds: [],
    } );
    renderIdentifyView( );

    expect( screen.getByTestId( "IdentifyView.noEvidence" ) ).toBeVisible( );
    // Previously this read "1/0" with a spinner that never resolved
    expect( screen.getByText( "0/0" ) ).toBeVisible( );
  } );
} );
