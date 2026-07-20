import { copyFile, mkdir } from "@dr.pogodin/react-native-fs";
import {
  duplicateGroupedMediaGroups,
  duplicateGroupedPhotoItem,
} from "components/PhotoImporter/helpers/duplicateGroupedMedia";

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  copyFile: jest.fn( ( ) => Promise.resolve( ) ),
  mkdir: jest.fn( ( ) => Promise.resolve( ) ),
} ) );

describe( "duplicateGroupedMedia", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "copies photo files and preserves crop metadata", async ( ) => {
    const photo = {
      image: {
        uri: "file:///tmp/galleryPhotos/photo.jpg",
        cropOriginalUri: "file:///tmp/photoUploads/original.jpg",
        crop: {
          x: 0.1,
          y: 0.2,
          w: 0.5,
          h: 0.5,
        },
      },
      isDuplicateUpload: true,
    };

    const duplicatedPhoto = await duplicateGroupedPhotoItem( photo );

    expect( copyFile ).toHaveBeenCalledTimes( 2 );
    expect( duplicatedPhoto.image.uri ).not.toEqual( photo.image.uri );
    expect( duplicatedPhoto.image.cropOriginalUri ).not.toEqual(
      photo.image.cropOriginalUri,
    );
    expect( duplicatedPhoto.image.crop ).toEqual( photo.image.crop );
    expect( duplicatedPhoto.isDuplicateUpload ).toBe( true );
  } );

  it( "duplicates selected groups as new groups", async ( ) => {
    const groups = [{
      photos: [{
        image: {
          uri: "file:///tmp/galleryPhotos/photo-1.jpg",
        },
      }],
    }, {
      photos: [{
        image: {
          uri: "file:///tmp/galleryPhotos/photo-2.jpg",
        },
      }],
    }];

    const duplicatedGroups = await duplicateGroupedMediaGroups( groups );

    expect( duplicatedGroups ).toHaveLength( 2 );
    expect( duplicatedGroups[0].photos?.[0].image.uri ).not.toEqual(
      groups[0].photos[0].image.uri,
    );
    expect( duplicatedGroups[1].photos?.[0].image.uri ).not.toEqual(
      groups[1].photos[0].image.uri,
    );
  } );
} );
