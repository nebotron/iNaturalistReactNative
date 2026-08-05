import {
  bakePendingGroupPhotoCrops,
  saveGroupPhotoCrop,
} from "components/PhotoImporter/helpers/groupPhotoCrops";
import cropImageFile from "sharedHelpers/cropImageFile";
import { preloadImage } from "sharedHelpers/imageCropPreload";
import useStore from "stores/useStore";

jest.mock( "sharedHelpers/cropImageFile", ( ) => jest.fn(
  ( ) => Promise.resolve( "file://cropped-2.jpg" ),
) );

jest.mock( "sharedHelpers/imageCropPreload", ( ) => ( {
  preloadImage: jest.fn( uri => Promise.resolve( {
    localUri: uri,
    size: { w: 100, h: 100 },
  } ) ),
} ) );

jest.mock( "sharedHelpers/cropPhotoMetadata", ( ) => ( {
  cropOriginalUriFromPath: jest.fn( path => path ),
  preserveCropOriginalPath: jest.fn(
    ( sourceUri, existing ) => Promise.resolve( existing || sourceUri ),
  ),
} ) );

jest.mock( "sharedHelpers/animalCropLog", ( ) => ( { saveAnimalCrop: jest.fn( ) } ) );
jest.mock( "sharedHelpers/cropFeedbackLog", ( ) => ( { recordCropFeedback: jest.fn( ) } ) );

const crop = {
  x: 0.1, y: 0.2, w: 0.3, h: 0.4,
};

const firstPhotoImage = ( ) => useStore.getState( ).groupedPhotos[0].photos[0].image;

describe( "bakePendingGroupPhotoCrops", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "writes the cropped file for a crop pinched in the grid", async ( ) => {
    useStore.getState( ).setGroupedPhotos( [
      { photos: [{ image: { uri: "file://photo.jpg" } }] },
    ] );
    saveGroupPhotoCrop( "file://photo.jpg", crop );

    await bakePendingGroupPhotoCrops( );

    expect( cropImageFile ).toHaveBeenCalledWith( "file://photo.jpg", crop, 100, 100 );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-2.jpg" );
  } );

  it( "rebakes from the original when an already-cropped photo is pinched again", async ( ) => {
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
            bakedCrop: oldCrop,
          },
        }],
      },
    ] );
    saveGroupPhotoCrop( "file://cropped-1.jpg", crop );

    await bakePendingGroupPhotoCrops( );

    expect( preloadImage ).toHaveBeenCalledWith( "file://original.jpg", "file://original.jpg", crop );
    expect( cropImageFile ).toHaveBeenCalledWith( "file://original.jpg", crop, 100, 100 );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-2.jpg" );
    expect( firstPhotoImage( ).cropOriginalUri ).toBe( "file://original.jpg" );
  } );

  it( "leaves a photo alone when its file already holds its crop", async ( ) => {
    useStore.getState( ).setGroupedPhotos( [
      {
        photos: [{
          image: {
            uri: "file://cropped-1.jpg",
            cropOriginalUri: "file://original.jpg",
            crop,
            bakedCrop: crop,
          },
        }],
      },
    ] );

    await bakePendingGroupPhotoCrops( );

    expect( cropImageFile ).not.toHaveBeenCalled( );
    expect( firstPhotoImage( ).uri ).toBe( "file://cropped-1.jpg" );
  } );
} );
