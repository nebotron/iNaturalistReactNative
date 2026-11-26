import {
  cropJobUris,
  groupPhotosFirstUris,
  startKeepingCropPreloads,
} from "components/SharedComponents/ImageCrop/keepCropPreloads";
import { InteractionManager } from "react-native";
import useStore from "stores/useStore";

const mockEnqueue = jest.fn( async ( ) => null );
jest.mock( "sharedHelpers/imageCropPreload", ( ) => ( {
  PRELOAD_LOOKAHEAD: 2,
  enqueuePreload: ( ...args ) => mockEnqueue( ...args ),
} ) );

const photo = ( uri, extra = {} ) => ( { image: { uri, ...extra.image }, ...extra.photo } );
const group = ( ...photos ) => ( { photos } );

const grid = [
  group( photo( "file:///a.jpg" ), photo( "file:///b.jpg" ) ),
  group( photo( "file:///c.jpg", {
    image: {
      cropOriginalUri: "file:///c-original.jpg",
      crop: {
        x: 0, y: 0, w: 0.5, h: 0.5,
      },
    },
  } ) ),
  group( photo( "file:///d.gif" ) ),
  group( photo( "file:///e.jpg", { photo: { pending: true } } ) ),
  group( photo( "file:///f.jpg" ), photo( "file:///g.jpg" ) ),
];

describe( "keepCropPreloads", ( ) => {
  beforeEach( ( ) => {
    mockEnqueue.mockClear( );
    jest.spyOn( InteractionManager, "runAfterInteractions" ).mockImplementation( task => {
      task( );
      return { cancel: jest.fn( ) };
    } );
  } );

  afterEach( ( ) => {
    useStore.setState( { groupedPhotos: [], groupCropResume: null } );
  } );

  it( "picks Group Photos' first photos still to crop, in grid order", ( ) => {
    // Cropped, GIF and still-copying photos are skipped
    expect( groupPhotosFirstUris( grid ) ).toEqual( ["file:///a.jpg", "file:///b.jpg"] );
  } );

  it( "picks the bulk crop's current photo and the next ones after it", ( ) => {
    const resume = {
      imageUri: "file:///b.jpg",
      pendingImageUris: ["file:///f.jpg", "file:///g.jpg", "file:///a.jpg"],
      cropImport: false,
      skipUris: [],
    };
    expect( cropJobUris( resume, grid ) )
      .toEqual( ["file:///b.jpg", "file:///f.jpg", "file:///g.jpg"] );
    expect( cropJobUris( null, grid ) ).toEqual( [] );
  } );

  it( "keeps both prepared as the store changes, the crop job first", ( ) => {
    useStore.setState( { groupedPhotos: grid, groupCropResume: null } );
    const stop = startKeepingCropPreloads( );
    expect( mockEnqueue.mock.calls.map( ( [uri, , , options] ) => [uri, options] ) ).toEqual( [
      ["file:///a.jpg", { background: true }],
      ["file:///b.jpg", { background: true }],
    ] );

    mockEnqueue.mockClear( );
    useStore.setState( {
      groupCropResume: {
        imageUri: "file:///c.jpg",
        pendingImageUris: ["file:///f.jpg"],
        cropImport: false,
        skipUris: [],
      },
    } );
    expect( mockEnqueue.mock.calls.map( ( [uri, source, crop, options] ) => [
      uri, source, crop, options,
    ] ) ).toEqual( [
      // A re-crop is prepared from the untouched original, with its crop
      ["file:///c.jpg", "file:///c-original.jpg", {
        x: 0, y: 0, w: 0.5, h: 0.5,
      }, {}],
      ["file:///f.jpg", "file:///f.jpg", null, {}],
      ["file:///a.jpg", "file:///a.jpg", null, { background: true }],
      ["file:///b.jpg", "file:///b.jpg", null, { background: true }],
    ] );

    stop( );
    mockEnqueue.mockClear( );
    useStore.setState( { groupedPhotos: [] } );
    expect( mockEnqueue ).not.toHaveBeenCalled( );
  } );
} );
