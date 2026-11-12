import {
  applyGroupPhotosCrop,
  applyGroupPhotosPinchCrop,
} from "components/PhotoImporter/helpers/groupPhotoCrops";
import cropImageFile from "sharedHelpers/cropImageFile";
import { awaitPendingGroupPhotoCrops } from "sharedHelpers/pendingGroupPhotoCrops";
import useStore from "stores/useStore";

jest.mock( "sharedHelpers/cropImageFile", ( ) => jest.fn(
  ( ) => Promise.resolve( "file://cropped-2.jpg" ),
) );

jest.mock( "sharedHelpers/cropPhotoMetadata", ( ) => ( {
  cropOriginalUriFromPath: jest.fn( path => path ),
  preserveCropOriginalPath: jest.fn(
    ( sourceUri, existing ) => Promise.resolve( existing || sourceUri ),
  ),
} ) );

jest.mock( "sharedHelpers/animalCropLog", ( ) => ( { saveAnimalCrop: jest.fn( ) } ) );

jest.mock( "sharedHelpers/imageFileSize", ( ) => jest.fn(
  ( ) => Promise.resolve( { w: 100, h: 100 } ),
) );

const crop = {
  x: 0.1, y: 0.2, w: 0.3, h: 0.4,
};

const size = { w: 100, h: 100 };

const firstPhotoImage = ( ) => useStore.getState( ).groupedPhotos[0].photos[0].image;

describe( "applyGroupPhotosCrop", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "writes the cropped file and keeps the original for a re-crop", async ( ) => {
    useStore.getState( ).setGroupedPhotos( [
      { photos: [{ image: { uri: "file://photo.jpg" } }] },
    ] );

    await applyGroupPhotosCrop( crop, "file://photo.jpg", "file://photo.jpg", size );

    expect( cropImageFile ).toHaveBeenCalledWith( "file://photo.jpg", crop, 100, 100, undefined, 1 );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-2.jpg" );
    expect( firstPhotoImage( ).cropOriginalUri ).toBe( "file://photo.jpg" );
    expect( firstPhotoImage( ).crop ).toEqual( crop );
  } );

  it( "crops an already-cropped photo from its untouched original", async ( ) => {
    const oldCrop = {
      x: 0.5, y: 0.5, w: 0.2, h: 0.2,
    };
    useStore.getState( ).setGroupedPhotos( [
      {
        photos: [{
          image: {
            uri: "file://cropped-1.jpg",
            cropOriginalUri: "file://original.jpg",
            crop: oldCrop,
          },
        }],
      },
    ] );

    await applyGroupPhotosCrop( crop, "file://cropped-1.jpg", "file://original.jpg", size );

    expect( cropImageFile ).toHaveBeenCalledWith( "file://original.jpg", crop, 100, 100, undefined, 1 );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-2.jpg" );
    expect( firstPhotoImage( ).cropOriginalUri ).toBe( "file://original.jpg" );
  } );
} );

describe( "applyGroupPhotosPinchCrop", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "crops a pinched photo, and follows its rename for the next pinch", async ( ) => {
    useStore.getState( ).setGroupedPhotos( [
      { photos: [{ image: { uri: "file://pinched.jpg" } }] },
    ] );

    applyGroupPhotosPinchCrop( "file://pinched.jpg", crop );
    await awaitPendingGroupPhotoCrops( );

    expect( cropImageFile ).toHaveBeenCalledWith(
      "file://pinched.jpg",
      crop,
      100,
      100,
      undefined,
      1,
    );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-2.jpg" );
    expect( firstPhotoImage( ).crop ).toEqual( crop );

    // The cell still knows the photo by the uri it was pinched under
    const nextCrop = {
      x: 0, y: 0, w: 0.5, h: 0.5,
    };
    applyGroupPhotosPinchCrop( "file://pinched.jpg", nextCrop );
    await awaitPendingGroupPhotoCrops( );

    expect( cropImageFile ).toHaveBeenLastCalledWith(
      "file://pinched.jpg",
      nextCrop,
      100,
      100,
      undefined,
      1,
    );
    expect( firstPhotoImage( ).crop ).toEqual( nextCrop );
  } );

  it( "leaves an uncropped photo alone when pinched back out to the whole frame", async ( ) => {
    useStore.getState( ).setGroupedPhotos( [
      { photos: [{ image: { uri: "file://whole.jpg" } }] },
    ] );

    applyGroupPhotosPinchCrop( "file://whole.jpg", {
      x: 0, y: 0, w: 1, h: 1,
    } );
    await awaitPendingGroupPhotoCrops( );

    expect( cropImageFile ).not.toHaveBeenCalled( );
    expect( firstPhotoImage( ).uri ).toBe( "file://whole.jpg" );
  } );
} );
