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

  it( "survives a load event that reports no source", ( ) => {
    mockDetection.mockReturnValue( null );
    renderCropImage( "ph://sourceless" );

    expect( ( ) => {
      fireEvent( screen.getByTestId( "GroupPhotoCropImage.photo" ), "load", {} );
    } ).not.toThrow( );
  } );
} );
