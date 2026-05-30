import jpeg from "jpeg-js";
import {
  alignPixelCropOutwardToJpegBlocks,
  isPixelCropBlockAligned,
  JPEG_COMPRESSION_BLOCK_SIZE,
  pixelCropFromNormalizedCrop,
} from "sharedHelpers/jpegCropBounds";

const createTestJpeg = ( width, height, quality = 85 ) => {
  const data = Buffer.alloc( width * height * 4 );

  for ( let y = 0; y < height; y += 1 ) {
    for ( let x = 0; x < width; x += 1 ) {
      const index = ( y * width + x ) * 4;
      data[index] = ( x * 7 + y * 3 ) % 256;
      data[index + 1] = ( x * 5 + y * 11 ) % 256;
      data[index + 2] = ( x * 13 + y * 2 ) % 256;
      data[index + 3] = 255;
    }
  }

  return jpeg.encode( { data, width, height }, quality );
};

const decodeJpeg = jpegBuffer => jpeg.decode( jpegBuffer, { useTArray: true } );

const extractRegion = ( image, crop ) => {
  const pixels = Buffer.alloc( crop.width * crop.height * 4 );

  for ( let y = 0; y < crop.height; y += 1 ) {
    for ( let x = 0; x < crop.width; x += 1 ) {
      const sourceIndex = ( ( crop.originY + y ) * image.width + ( crop.originX + x ) ) * 4;
      const targetIndex = ( y * crop.width + x ) * 4;
      pixels[targetIndex] = image.data[sourceIndex];
      pixels[targetIndex + 1] = image.data[sourceIndex + 1];
      pixels[targetIndex + 2] = image.data[sourceIndex + 2];
      pixels[targetIndex + 3] = image.data[sourceIndex + 3];
    }
  }

  return {
    data: pixels,
    width: crop.width,
    height: crop.height,
  };
};

const pixelsEqual = ( left, right ) => (
  Buffer.from( left ).equals( Buffer.from( right ) )
);

const losslessBlockAlignedCrop = ( sourceImage, crop ) => (
  extractRegion( sourceImage, crop )
);

const lossyJpegCrop = ( sourceImage, crop, quality = 75 ) => {
  const croppedPixels = extractRegion( sourceImage, crop );
  const encoded = jpeg.encode( croppedPixels, quality );
  return decodeJpeg( encoded.data );
};

describe( "jpegCropBounds", ( ) => {
  it( "expands outward to the nearest JPEG compression block boundary", ( ) => {
    const aligned = alignPixelCropOutwardToJpegBlocks(
      {
        originX: 10,
        originY: 10,
        width: 50,
        height: 50,
      },
      128,
      128,
    );

    expect( aligned ).toEqual( {
      originX: 8,
      originY: 8,
      width: 56,
      height: 56,
    } );
    expect( isPixelCropBlockAligned( aligned ) ).toBe( true );
  } );

  it( "keeps already aligned crops unchanged when they fit in the image", ( ) => {
    const aligned = alignPixelCropOutwardToJpegBlocks(
      {
        originX: 16,
        originY: 24,
        width: 64,
        height: 32,
      },
      128,
      128,
    );

    expect( aligned ).toEqual( {
      originX: 16,
      originY: 24,
      width: 64,
      height: 32,
    } );
  } );

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
} );

describe( "JPEG crop pixel preservation", ( ) => {
  const imageWidth = 128;
  const imageHeight = 128;
  const sourceJpeg = createTestJpeg( imageWidth, imageHeight );
  const sourceImage = decodeJpeg( sourceJpeg.data );

  it( "preserves pixels when cropping on compression block boundaries", ( ) => {
    const alignedCrop = {
      originX: 16,
      originY: 16,
      width: 64,
      height: 64,
    };

    expect( isPixelCropBlockAligned( alignedCrop, JPEG_COMPRESSION_BLOCK_SIZE ) ).toBe( true );

    const losslessCrop = losslessBlockAlignedCrop( sourceImage, alignedCrop );
    const referenceRegion = extractRegion( sourceImage, alignedCrop );

    expect( pixelsEqual( losslessCrop.data, referenceRegion.data ) ).toBe( true );
  } );

  it( "changes pixels when cropping off compression block boundaries", ( ) => {
    const unalignedCrop = {
      originX: 10,
      originY: 10,
      width: 50,
      height: 50,
    };

    expect( isPixelCropBlockAligned( unalignedCrop, JPEG_COMPRESSION_BLOCK_SIZE ) ).toBe( false );

    const referenceRegion = extractRegion( sourceImage, unalignedCrop );
    const lossyCrop = lossyJpegCrop( sourceImage, unalignedCrop );

    expect( pixelsEqual( lossyCrop.data, referenceRegion.data ) ).toBe( false );
  } );

  it( "uses block-aligned bounds for user-selected crops before cropping", ( ) => {
    const userCrop = {
      originX: 10,
      originY: 10,
      width: 50,
      height: 50,
    };
    const alignedCrop = alignPixelCropOutwardToJpegBlocks(
      userCrop,
      imageWidth,
      imageHeight,
    );

    expect( isPixelCropBlockAligned( alignedCrop ) ).toBe( true );

    const losslessCrop = losslessBlockAlignedCrop( sourceImage, alignedCrop );
    const referenceRegion = extractRegion( sourceImage, alignedCrop );

    expect( pixelsEqual( losslessCrop.data, referenceRegion.data ) ).toBe( true );
  } );
} );

describe( "cropImageFile block alignment", ( ) => {
  beforeEach( ( ) => {
    jest.resetModules( );
  } );

  it( "passes block-aligned pixel bounds to the native cropper", async ( ) => {
    const cropImage = jest.fn( ( ) => Promise.resolve( "/tmp/cropped.jpg" ) );
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
      8,
      8,
      56,
      56,
      "/tmp/output/test-crop-id.jpg",
    );
  } );
} );
