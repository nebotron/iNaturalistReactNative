import { NativeModules } from "react-native";
import detectSubjectInImage
  from "sharedHelpers/detectSubjectInImage";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";

describe( "detectSubjectInImage", ( ) => {
  const originalImageCropper = NativeModules.ImageCropper;
  const mockDetectSubjectBounds = jest.fn( );

  beforeEach( ( ) => {
    mockDetectSubjectBounds.mockReset( );
    NativeModules.ImageCropper = {
      detectSubjectBounds: mockDetectSubjectBounds,
    };
  } );

  afterAll( ( ) => {
    NativeModules.ImageCropper = originalImageCropper;
  } );

  it(
    "falls back to the default square crop when native detection returns no bounds",
    async ( ) => {
      mockDetectSubjectBounds.mockResolvedValue( null );

      const crop = await detectSubjectInImage( "file:///tmp/photo.jpg", 2000, 1000 );
      expect( crop ).toEqual( defaultSquareCrop( 2000, 1000 ) );
    },
  );

  it( "uses detected bounds when native detection succeeds", async ( ) => {
    mockDetectSubjectBounds.mockResolvedValue( {
      x: 0.4,
      y: 0.3,
      width: 0.2,
      height: 0.2,
    } );

    const crop = await detectSubjectInImage( "file:///tmp/photo.jpg", 2000, 1000 );

    expect( mockDetectSubjectBounds ).toHaveBeenCalledWith( "/tmp/photo.jpg", "A" );
    expect( crop.w ).toBe( crop.h );
    expect( crop.x ).toBeGreaterThanOrEqual( 0 );
    expect( crop.y ).toBeGreaterThanOrEqual( 0 );
  } );
} );
