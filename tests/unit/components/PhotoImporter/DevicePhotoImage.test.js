import { fireEvent, render, screen } from "@testing-library/react-native";
import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import React from "react";
import { Image } from "react-native";

const GENERATED = "file://caches/directory/path/inatDeviceThumbnails/abc.jpg";
const ORIGINAL = "ph://original-photo";

const mockInvalidate = jest.fn( );

jest.mock( "sharedHelpers/useDeviceImageThumbnail", ( ) => ( {
  __esModule: true,
  default: ( ) => "file://caches/directory/path/inatDeviceThumbnails/abc.jpg",
  invalidateDeviceImageThumbnail: ( ...args ) => mockInvalidate( ...args ),
  isGeneratedThumbnailUri: uri => Boolean( uri?.includes( "inatDeviceThumbnails" ) ),
} ) );

// The photo itself is a plain <Image> inside CachedImage, which carries no
// role or label of its own: what it is drawing is the whole assertion.
const photoSource = ( ) => screen.UNSAFE_getByType( Image ).props.source;
const photoImage = ( ) => screen.UNSAFE_getByType( Image );

describe( "DevicePhotoImage", ( ) => {
  beforeEach( ( ) => mockInvalidate.mockClear( ) );

  it( "draws the generated thumbnail", ( ) => {
    render( <DevicePhotoImage uri={ORIGINAL} cellWidth={100} /> );

    expect( photoSource( ) ).toEqual( { uri: GENERATED } );
  } );

  it( "falls back to the photo when its thumbnail won't decode", ( ) => {
    render( <DevicePhotoImage uri={ORIGINAL} cellWidth={100} /> );

    // An undecodable thumbnail is cached under the photo's key and handed to
    // every cell that asks for it, so without this the cell shows a placeholder
    // (or a black square) for as long as that file is on disk.
    fireEvent( photoImage( ), "error" );

    expect( photoSource( ) ).toEqual( { uri: ORIGINAL } );
    expect( mockInvalidate ).toHaveBeenCalledWith( GENERATED, ORIGINAL );
  } );

  it( "does not throw away the photo itself when that is what failed", ( ) => {
    render( <DevicePhotoImage uri={ORIGINAL} cellWidth={100} /> );
    fireEvent( photoImage( ), "error" );
    mockInvalidate.mockClear( );

    fireEvent( photoImage( ), "error" );

    expect( mockInvalidate ).not.toHaveBeenCalled( );
  } );
} );
