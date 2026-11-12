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

  it.each( [2041, 2044, 2051, 2056] )(
    "snaps a %ipx square crop to the upload size",
    side => {
      expect(
        pixelCropFromNormalizedCrop(
          {
            x: 1003 / 4032,
            y: 501 / 3024,
            w: side / 4032,
            h: side / 3024,
          },
          4032,
          3024,
          2048,
        ),
      ).toEqual( {
        originX: 1003,
        originY: 501,
        width: 2048,
        height: 2048,
      } );
    },
  );

  it.each( [2039, 2057] )( "leaves a %ipx crop alone, too far from the upload size", side => {
    const pixelCrop = pixelCropFromNormalizedCrop(
      {
        x: 0, y: 0, w: side / 4032, h: side / 3024,
      },
      4032,
      3024,
      2048,
    );

    expect( pixelCrop.width ).toBe( side );
    expect( pixelCrop.height ).toBe( side );
  } );

  it( "moves a snapped crop back inside the image edge", ( ) => {
    const pixelCrop = pixelCropFromNormalizedCrop(
      {
        x: ( 4032 - 2044 ) / 4032, y: 0, w: 2044 / 4032, h: 2044 / 3024,
      },
      4032,
      3024,
      2048,
    );

    expect( pixelCrop ).toEqual( {
      originX: 4032 - 2048,
      originY: 0,
      width: 2048,
      height: 2048,
    } );
  } );

  it( "doesn't snap past an image smaller than the upload size", ( ) => {
    const pixelCrop = pixelCropFromNormalizedCrop(
      {
        x: 0, y: 0, w: 1, h: 1,
      },
      2045,
      2045,
      2048,
    );

    expect( pixelCrop.width ).toBe( 2045 );
    expect( pixelCrop.height ).toBe( 2045 );
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
  const loadCropImageFile = cropImage => {
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
    jest.doMock( "sharedHelpers/tunableParams", ( ) => ( {
      getTunable: ( ) => 2048,
    } ) );
    return require( "sharedHelpers/cropImageFile" ).default;
  };

  beforeEach( ( ) => {
    jest.resetModules( );
  } );

  it( "passes the selected bounds unaligned, snapped to the upload size", async ( ) => {
    const cropImage = jest.fn( ( ) => Promise.resolve( {
      path: "/tmp/cropped.jpg",
      outputLevel: 100,
      attempts: 1,
    } ) );
    const cropImageFile = loadCropImageFile( cropImage );

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
      1,
      2048,
    );

    cropImage.mockClear( );
    await cropImageFile(
      "file:///tmp/source.jpg",
      {
        x: 1003 / 4032,
        y: 501 / 3024,
        w: 2051 / 4032,
        h: 2051 / 3024,
      },
      4032,
      3024,
      "/tmp/output",
    );

    expect( cropImage ).toHaveBeenCalledWith(
      "/tmp/source.jpg",
      1003,
      501,
      2048,
      2048,
      "/tmp/output/test-crop-id.jpg",
      1,
      2048,
    );
  } );

  it( "applies brightness in the one native crop, writing one file", async ( ) => {
    const cropImage = jest.fn( ( ) => Promise.resolve( {
      path: "/tmp/output/test-crop-id.jpg",
      outputLevel: 100,
      attempts: 1,
    } ) );
    const cropImageFile = loadCropImageFile( cropImage );

    const uri = await cropImageFile(
      "file:///tmp/source.jpg",
      {
        x: 0, y: 0, w: 1, h: 1,
      },
      128,
      128,
      "/tmp/output",
      1.4,
    );

    expect( cropImage ).toHaveBeenCalledTimes( 1 );
    expect( cropImage.mock.calls[0][6] ).toBe( 1.4 );
    expect( uri ).toBe( "file:///tmp/output/test-crop-id.jpg" );
  } );
} );
