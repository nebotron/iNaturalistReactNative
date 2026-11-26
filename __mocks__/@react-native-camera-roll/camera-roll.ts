import mockFaker from "tests/helpers/faker";

export const nativeInterface = jest.fn( );
export const CameraRoll = {
  getPhotos: jest.fn( ( ) => new Promise( resolve => {
    resolve( {
      page_info: {
        end_cursor: jest.fn( ),
        has_next_page: false,
      },
      edges: [
        {
          node: {
            image: {
              filename: "IMG_20210901_123456.jpg",
              filepath: "/path/to/IMG_20210901_123456.jpg",
              extension: "jpg",
              uri: "file:///path/to/IMG_20210901_123456.jpg",
              height: 1920,
              width: 1080,
              fileSize: 123456,
              playableDuration: NaN,
              orientation: 1,
            },
          },
        },
      ],
    } );
  } ) ),
  getAlbums: jest.fn( ( ) => ( {
    // Expecting album titles as keys and photo counts as values
    // "My Amazing album": 12
  } ) ),
  save: jest.fn( ( _uri, _options = {} ) => mockFaker.system.filePath( ) ),
  saveAsset: jest.fn( ( _uri, _options = {} ) => Promise.resolve( {
    node: {
      id: "MOCK-ASSET-ID",
      image: {
        uri: "ph://MOCK-ASSET-ID",
      },
    },
  } ) ),
  deletePhotos: jest.fn( () => Promise.resolve( ) ),
};

export const iosReadGalleryPermission = jest.fn( () => Promise.resolve( "granted" ) );
export const iosRequestReadWriteGalleryPermission = jest.fn( () => Promise.resolve( "granted" ) );
export const iosRequestAddOnlyGalleryPermission = jest.fn( () => Promise.resolve( "granted" ) );
export const iosRefreshGallerySelection = jest.fn( () => Promise.resolve( true ) );
export const cameraRollEventEmitter = { addListener: jest.fn( ), removeListener: jest.fn( ) };
