import type backfillCameraInfo from "sharedHelpers/backfillCameraInfo";
import { readLibraryCameraInfo } from "sharedHelpers/findLibraryOriginal";

const mockReadLibraryCameraInfo = readLibraryCameraInfo as jest.Mock;

jest.mock( "sharedHelpers/findLibraryOriginal", ( ) => ( {
  libraryOriginalQuery: ( obsPhoto: { uuid: string } ) => ( { uuid: obsPhoto.uuid } ),
  readLibraryCameraInfo: jest.fn( ),
} ) );

jest.mock( "sharedHelpers/photoCameraInfo", ( ) => ( {
  readCameraInfo: jest.fn( async ( ) => null ),
} ) );

// One store for every MMKV instance, as the file on disk is across launches.
jest.mock( "react-native-mmkv", ( ) => {
  const { MMKV } = jest.requireActual( "react-native-mmkv" );
  const holder = global as { mockSharedMMKV?: unknown };
  holder.mockSharedMMKV ??= new MMKV( );
  return { MMKV: function MockMMKV( ) { return holder.mockSharedMMKV; } };
} );

const DAY_MS = 24 * 60 * 60 * 1000;

const makeObsPhoto = ( uuid: string ) => ( {
  uuid,
  cameraInfo: undefined as string | undefined,
  photo: {},
  isValid: ( ) => true,
} );

const realm = {
  isClosed: false,
  write: ( callback: ( ) => void ) => callback( ),
};

// A fresh module per run, as on a new launch: its session state lives in
// module scope.
const loadBackfill = ( ) => {
  let backfill: typeof backfillCameraInfo;
  jest.isolateModules( ( ) => {
    backfill = jest.requireActual( "sharedHelpers/backfillCameraInfo" ).default;
  } );
  // @ts-expect-error assigned in isolateModules
  return backfill;
};

const run = async ( obsPhotos: ReturnType<typeof makeObsPhoto>[] ) => loadBackfill( )(
  // @ts-expect-error minimal Realm stand-in
  realm,
  [{ observationPhotos: obsPhotos }],
  3,
);

describe( "backfillCameraInfo", ( ) => {
  beforeEach( ( ) => {
    jest.useFakeTimers( { now: 1000 * DAY_MS } );
    mockReadLibraryCameraInfo.mockReset( );
  } );

  afterEach( ( ) => jest.useRealTimers( ) );

  it( "saves the camera settings it reads", async ( ) => {
    mockReadLibraryCameraInfo.mockResolvedValue( { camera: "Canon EOS R7" } );
    const obsPhoto = makeObsPhoto( "filled" );
    await run( [obsPhoto] );
    expect( JSON.parse( obsPhoto.cameraInfo ?? "{}" ) ).toEqual( { camera: "Canon EOS R7" } );
  } );

  it( "doesn't read a photo without settings again on the next launch", async ( ) => {
    mockReadLibraryCameraInfo.mockResolvedValue( null );
    await run( [makeObsPhoto( "unfillable" )] );
    expect( mockReadLibraryCameraInfo ).toHaveBeenCalledTimes( 1 );

    await run( [makeObsPhoto( "unfillable" )] );
    expect( mockReadLibraryCameraInfo ).toHaveBeenCalledTimes( 1 );
  } );

  it( "reads a photo without settings again after a week", async ( ) => {
    mockReadLibraryCameraInfo.mockResolvedValue( null );
    await run( [makeObsPhoto( "retried" )] );

    jest.setSystemTime( 1008 * DAY_MS );
    mockReadLibraryCameraInfo.mockResolvedValue( { camera: "iPhone 16 Pro" } );
    const obsPhoto = makeObsPhoto( "retried" );
    await run( [obsPhoto] );
    expect( mockReadLibraryCameraInfo ).toHaveBeenCalledTimes( 2 );
    expect( obsPhoto.cameraInfo ).toBeDefined( );
  } );
} );
