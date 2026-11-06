import pixelCropFromNormalizedCrop from "sharedHelpers/pixelCropBounds";

describe( "pixelCropFromNormalizedCrop", ( ) => {
  it( "converts normalized crops to pixel crops", ( ) => {
    expect(
      pixelCropFromNormalizedCrop(
        {
          x: 0.25,
          y: 0.5,
          w: 0.5,
          h: 0.25,
        },
        200,
        400,
      ),
    ).toEqual( {
      originX: 50,
      originY: 200,
      width: 100,
      height: 100,
    } );
  } );

  it( "keeps a 2048px crop at 2048px wherever it sits", ( ) => {
    expect(
      pixelCropFromNormalizedCrop(
        {
          x: 1003 / 4032,
          y: 501 / 3024,
          w: 2048 / 4032,
          h: 2048 / 3024,
        },
        4032,
        3024,
      ),
    ).toEqual( {
      originX: 1003,
      originY: 501,
      width: 2048,
      height: 2048,
    } );
  } );

  it( "keeps a square selection square when normalized rounding is a pixel off", ( ) => {
    const pixelCrop = pixelCropFromNormalizedCrop(
      {
        x: 0.1, y: 0.0, w: 999.5 / 3001, h: 999.5 / 2001,
      },
      3001,
      2001,
    );

    expect( pixelCrop.width ).toBe( pixelCrop.height );
    expect( pixelCrop.width ).toBeLessThanOrEqual( 1000 );
  } );

  it( "keeps the crop inside the image", ( ) => {
    const pixelCrop = pixelCropFromNormalizedCrop(
      {
        x: 0.9, y: -0.1, w: 0.3, h: 0.5,
      },
      1000,
      800,
    );

    expect( pixelCrop.originX + pixelCrop.width ).toBeLessThanOrEqual( 1000 );
    expect( pixelCrop.originY ).toBe( 0 );
    expect( pixelCrop.originY + pixelCrop.height ).toBeLessThanOrEqual( 800 );
  } );
} );

describe( "cropImageFile bounds", ( ) => {
  beforeEach( ( ) => {
    jest.resetModules( );
  } );

  it( "passes the selected pixel bounds to the native cropper unaligned", async ( ) => {
    const cropImage = jest.fn( ( ) => Promise.resolve( {
      path: "/tmp/cropped.jpg",
      outputLevel: 100,
      attempts: 1,
    } ) );
    jest.doMock( "react-native", ( ) => ( {
      NativeModules: {
        ImageCropper: { cropImage },
      },
    } ) );
    jest.doMock( "@dr.pogodin/react-native-fs", ( ) => ( {
      mkdir: jest.fn( ( ) => Promise.resolve( ) ),
    } ) );
    jest.doMock( "uuid", ( ) => ( {
      v4: ( ) => "test-crop-id",
    } ) );

    const cropImageFile = require( "sharedHelpers/cropImageFile" ).default;

    await cropImageFile(
      "file:///tmp/source.jpg",
      {
        x: 10 / 128,
        y: 10 / 128,
        w: 50 / 128,
        h: 50 / 128,
      },
      128,
      128,
      "/tmp/output",
    );

    expect( cropImage ).toHaveBeenCalledWith(
      "/tmp/source.jpg",
      10,
      10,
      50,
      50,
      "/tmp/output/test-crop-id.jpg",
    );
  } );
} );
