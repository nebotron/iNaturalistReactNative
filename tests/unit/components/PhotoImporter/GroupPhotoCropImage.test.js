import { fireEvent, screen } from "@testing-library/react-native";
import GroupPhotoCropImage from "components/PhotoImporter/GroupPhotoCropImage";
import React from "react";
import { renderComponent } from "tests/helpers/render";

// The real one drags in reanimated/gesture-handler. All this component needs
// from it is somewhere to draw renderImage() and a ref carrying applyTransform,
// without which the framing effect bails out and nothing is ever framed.
jest.mock( "sharedHelpers/useDeviceImageThumbnail", ( ) => ( {
  __esModule: true,
  // Both the thumbnail and the full-resolution generation failing is what puts
  // a cell on the ph:// fallback path this test is about.
  default: jest.fn( ( ) => undefined ),
  invalidateDeviceImageThumbnail: jest.fn( ),
} ) );

const mockDetection = jest.fn( );
jest.mock( "sharedHelpers/useThumbnailSubjectDetection", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockDetection( ...args ),
} ) );

const renderCropImage = uri => renderComponent(
  <GroupPhotoCropImage
    cropSourceUri={uri}
    savedCrop={null}
    size={120}
    onCropChange={jest.fn( )}
  />,
);

describe( "GroupPhotoCropImage", ( ) => {
  afterEach( ( ) => {
    jest.clearAllMocks( );
  } );

  // The overlay's backdrop is opaque black and covers the whole cell, and the
  // photo above it is hidden until it has been framed. Showing the backdrop
  // while the photo is still hidden is a solid black square, not a photo.
  it( "does not black out a cell whose photo it could not frame", ( ) => {
    // No detection, which is what happens when the thumbnail failed to
    // generate: there is nothing to measure the photo's dimensions from.
    mockDetection.mockReturnValue( null );
    // Distinct per test: paintedImages is process-wide by design.
    renderCropImage( "ph://unframeable" );

    // The fallback ph:// original draws, but reports no dimensions with it.
    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {
      nativeEvent: {},
    } );

    expect( screen.queryByTestId( "GroupPhotoCropImage.backdrop" ) ).toBeNull( );
  } );

  it( "still backs a framed photo, so the grid tile can't show through", ( ) => {
    mockDetection.mockReturnValue( {
      crop: null,
      imageWidth: 400,
      imageHeight: 300,
    } );
    renderCropImage( "ph://framed" );

    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {
      nativeEvent: { source: { width: 400, height: 300 } },
    } );

    expect( screen.getByTestId( "GroupPhotoCropImage.backdrop" ) ).toBeTruthy( );
  } );

  // A load event that carries no source at all used to throw out of the
  // handler, after painted had already been set -- leaving the cell in exactly
  // the framed-by-nothing state the backdrop must not paint over.
  it( "survives a load event that reports no source", ( ) => {
    mockDetection.mockReturnValue( null );
    renderCropImage( "ph://sourceless" );

    expect( ( ) => {
      fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {} );
    } ).not.toThrow( );
  } );
} );
