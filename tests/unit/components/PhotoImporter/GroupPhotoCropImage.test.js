import { exists } from "@dr.pogodin/react-native-fs";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import GroupPhotoCropImage from "components/PhotoImporter/GroupPhotoCropImage";
import React from "react";
import { renderComponent } from "tests/helpers/render";

const mockThumbnail = jest.fn( ( ) => undefined );
// The real one drags in reanimated/gesture-handler. All this component needs
// from it is somewhere to draw renderImage() and a ref carrying applyTransform,
// without which the framing effect bails out and nothing is ever framed.
jest.mock( "sharedHelpers/useDeviceImageThumbnail", ( ) => ( {
  __esModule: true,
  // Both the thumbnail and the full-resolution generation failing is what puts
  // a cell on the ph:// fallback path this test is about.
  default: ( ...args ) => mockThumbnail( ...args ),
  invalidateDeviceImageThumbnail: jest.fn( ),
} ) );

// eslint-disable-next-line global-require
const { invalidateDeviceImageThumbnail } = require( "sharedHelpers/useDeviceImageThumbnail" );

const mockDetection = jest.fn( );
jest.mock( "sharedHelpers/useThumbnailSubjectDetection", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockDetection( ...args ),
} ) );

// The framing the cell applies, captured at the point it is computed. The
// dimensions it is computed from are the whole point of these tests: they
// decide where in the cell the photo lands, so framing against the wrong ones
// slides the photo out from under the crop box.
const mockCropToTransform = jest.fn( ( ) => ( {
  scale: 1,
  translateX: 0,
  translateY: 0,
  focalX: 0,
  focalY: 0,
} ) );
jest.mock( "sharedHelpers/normalizedCropToImageZoomTransform", ( ) => ( {
  normalizedCropToImageZoomTransform: ( ...args ) => mockCropToTransform( ...args ),
} ) );

// Calls the transform helper itself, which would otherwise be
// indistinguishable from the cell's own framing call.
jest.mock( "sharedHelpers/cropPanTranslateLimits", ( ) => ( {
  computeCropPanTranslateLimits: ( ) => ( {
    minTotalTranslateX: -Infinity,
    maxTotalTranslateX: Infinity,
    minTotalTranslateY: -Infinity,
    maxTotalTranslateY: Infinity,
  } ),
} ) );

const framedDimensions = ( ) => mockCropToTransform.mock.calls
  .map( call => [call[0], call[1]] );

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
    mockThumbnail.mockReturnValue( undefined );
  } );

  // A RAW original (.CR3) has no thumbnail iOS can build at full resolution, so
  // the full-resolution request comes back as the original uri itself. Adopting
  // that as an "upgrade" swapped the working thumbnail out of the cell's image
  // view for a file that draws slowly or not at all, and the black backdrop was
  // left covering the cell every time the user scrolled back to it.
  it( "keeps showing the thumbnail when full-resolution generation fails", ( ) => {
    const cropSourceUri = "file:///galleryPhotos/raw.CR3";
    // maxPixel ordering matches the component: full resolution first.
    mockThumbnail.mockImplementation( ( uri, maxPixel ) => ( maxPixel >= 8192
      // Failed generation resolves to the original, not to a generated file.
      ? cropSourceUri
      : "file:///thumbnails/raw.jpg" ) );
    mockDetection.mockReturnValue( {
      crop: null,
      imageWidth: 400,
      imageHeight: 300,
    } );
    renderCropImage( cropSourceUri );

    expect( screen.getByTestId( "GroupPhotoCropImage.photo" ).props.source.uri )
      .toBe( "file:///thumbnails/raw.jpg" );
  } );

  // The cell upgrades its source in place, so a flag saying "something painted"
  // outlived the bitmap it referred to: the backdrop stayed while the native
  // image view was decoding the replacement.
  it( "drops the backdrop while an upgraded source has yet to paint", ( ) => {
    // Flipped once the cell has painted its thumbnail, so the re-render the
    // load event causes is the one that swaps the source -- the same order the
    // real generation lands in.
    let fullResolutionReady = false;
    mockThumbnail.mockImplementation( ( uri, maxPixel ) => {
      if ( maxPixel < 8192 ) return "file:///thumbnails/upgraded.jpg";
      return fullResolutionReady
        ? "file:///thumbnails/upgraded-full.jpg"
        : undefined;
    } );
    mockDetection.mockReturnValue( {
      crop: null,
      imageWidth: 400,
      imageHeight: 300,
    } );
    renderCropImage( "ph://upgraded" );

    fullResolutionReady = true;
    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {
      nativeEvent: { source: { width: 400, height: 300 } },
    } );

    expect( screen.getByTestId( "GroupPhotoCropImage.photo" ).props.source.uri )
      .toBe( "file:///thumbnails/upgraded-full.jpg" );
    expect( screen.queryByTestId( "GroupPhotoCropImage.backdrop" ) ).toBeNull( );
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
  // An original that is gone from disk explains the load failure on its own,
  // and the generated thumbnail is then the only copy of that photo left: the
  // Aug 20 log threw away three 10MB thumbnails that had generated perfectly
  // well, and regenerated them on the next visit to do it again.
  it( "keeps the thumbnail when the photo it came from is gone", async ( ) => {
    exists.mockResolvedValue( false );
    mockThumbnail.mockReturnValue( "file:///thumbs/raw.jpg" );
    renderCropImage( "file:///galleryPhotos/raw.CR3" );

    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "error", {
      nativeEvent: {
        error: "The file “raw.CR3” couldn’t be opened because there is no such file.",
      },
    } );

    await waitFor( ( ) => {
      expect( exists ).toHaveBeenCalledWith( "/galleryPhotos/raw.CR3" );
    } );
    expect( invalidateDeviceImageThumbnail ).not.toHaveBeenCalled( );
  } );

  it( "discards a thumbnail that failed while its photo is still there", async ( ) => {
    exists.mockResolvedValue( true );
    mockThumbnail.mockReturnValue( "file:///thumbs/raw.jpg" );
    renderCropImage( "file:///galleryPhotos/raw.CR3" );

    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "error", {
      nativeEvent: { error: "decode failed" },
    } );

    await waitFor( ( ) => {
      expect( invalidateDeviceImageThumbnail ).toHaveBeenCalled( );
    } );
  } );

  // A tile-sized thumbnail of a ph:// asset used to come back square-cropped,
  // so the aspect ratio the cell framed itself with belonged to no file it ever
  // drew. The photo was then translated off by the difference, and for a
  // tightly framed subject that is far enough to leave the cell showing nothing
  // but the overlay's opaque black backdrop.
  it( "re-frames onto the aspect ratio of the photo it actually drew", ( ) => {
    mockThumbnail.mockReturnValue( "file:///thumbnails/square.jpg" );
    mockDetection.mockReturnValue( {
      crop: {
        x: 0.05, y: 0.05, w: 0.2, h: 0.2,
      },
      // A square crop of the photo, not the photo.
      imageWidth: 1000,
      imageHeight: 1000,
    } );
    renderCropImage( "ph://squareThumbnail" );

    expect( framedDimensions( ) ).toEqual( [[1000, 1000]] );

    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {
      nativeEvent: { source: { width: 6000, height: 4000 } },
    } );

    expect( framedDimensions( ).at( -1 ) ).toEqual( [6000, 4000] );
  } );

  // The thumbnail a photo is measured in rounds to a slightly different ratio
  // than the original (6000x4000 scaled to 2048 is 2048x1365), which is not a
  // reason to re-frame a cell -- least of all one the user has just pinched.
  it( "leaves a cell alone when the photo lands at the ratio it was framed at", ( ) => {
    mockThumbnail.mockReturnValue( "file:///thumbnails/wide.jpg" );
    mockDetection.mockReturnValue( {
      crop: {
        x: 0.1, y: 0.1, w: 0.3, h: 0.3,
      },
      imageWidth: 2048,
      imageHeight: 1365,
    } );
    renderCropImage( "ph://wideThumbnail" );

    fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {
      nativeEvent: { source: { width: 6000, height: 4000 } },
    } );

    expect( framedDimensions( ) ).toEqual( [[2048, 1365]] );
  } );

  it( "survives a load event that reports no source", ( ) => {
    mockDetection.mockReturnValue( null );
    renderCropImage( "ph://sourceless" );

    expect( ( ) => {
      fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {} );
    } ).not.toThrow( );
  } );
} );
