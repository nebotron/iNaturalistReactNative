import { buildPhotoLibraryListItems } from "components/PhotoImporter/CustomPhotoLibrary/helpers/buildPhotoLibraryListItems";
import { groupLibraryPhotosByDate } from
  "components/PhotoImporter/CustomPhotoLibrary/helpers/groupLibraryPhotosByDate";
import { getMarkedDevicePhotoUris } from
  "components/PhotoImporter/CustomPhotoLibrary/helpers/getMarkedDevicePhotoUris";
import type { LibraryPhoto } from "components/PhotoImporter/CustomPhotoLibrary/types";
import useStore from "stores/useStore";

const buildLibraryPhoto = ( id: string, timestampMs: number ): LibraryPhoto => ( {
  asset: {
    id,
    uri: `file:///photo-${id}.jpg`,
    fileName: `${id}.jpg`,
    type: "image/jpeg",
  },
  deviceUri: `ph://${id}`,
  id,
  isVideo: false,
  photo: {
    node: {
      id,
      type: "image/jpeg",
      subTypes: [],
      sourceType: "UserLibrary",
      group_name: [],
      image: {
        filename: `${id}.jpg`,
        filepath: null,
        extension: "jpg",
        uri: `ph://${id}`,
        height: 100,
        width: 100,
        fileSize: 1000,
        playableDuration: 0,
        orientation: null,
      },
      timestamp: timestampMs / 1000,
      modificationTimestamp: timestampMs / 1000,
      location: null,
    },
  },
  timestampMs,
} );

describe( "groupLibraryPhotosByDate", ( ) => {
  it( "groups photos by day and sorts newest dates first", ( ) => {
    const dayOne = new Date( "2024-05-01T10:00:00" ).getTime( );
    const dayTwoMorning = new Date( "2024-05-02T09:00:00" ).getTime( );
    const dayTwoEvening = new Date( "2024-05-02T18:00:00" ).getTime( );

    const groups = groupLibraryPhotosByDate( [
      buildLibraryPhoto( "a", dayOne ),
      buildLibraryPhoto( "b", dayTwoMorning ),
      buildLibraryPhoto( "c", dayTwoEvening ),
    ] );

    expect( groups ).toHaveLength( 2 );
    expect( groups[0].photos ).toHaveLength( 2 );
    expect( groups[1].photos ).toHaveLength( 1 );
  } );
} );

describe( "buildPhotoLibraryListItems", ( ) => {
  it( "inserts date headers and rows of three photos", ( ) => {
    const i18n = {
      t: key => ( key === "date-format-long"
        ? "MMMM d, yyyy"
        : key ),
    };
    const photos = [
      buildLibraryPhoto( "1", new Date( "2024-05-02T10:00:00" ).getTime( ) ),
      buildLibraryPhoto( "2", new Date( "2024-05-02T11:00:00" ).getTime( ) ),
      buildLibraryPhoto( "3", new Date( "2024-05-02T12:00:00" ).getTime( ) ),
      buildLibraryPhoto( "4", new Date( "2024-05-02T13:00:00" ).getTime( ) ),
    ];

    const listItems = buildPhotoLibraryListItems( photos, i18n );

    expect( listItems[0].type ).toBe( "header" );
    expect( listItems[1].type ).toBe( "row" );
    expect( listItems[1].photos ).toHaveLength( 3 );
    expect( listItems[2].type ).toBe( "row" );
    expect( listItems[2].photos ).toHaveLength( 1 );
  } );
} );

describe( "getMarkedDevicePhotoUris", ( ) => {
  beforeEach( ( ) => {
    useStore.getState( ).resetObservationFlowSlice( );
  } );

  it( "includes device URIs selected during the current import session", ( ) => {
    useStore.setState( {
      originalDevicePhotoUris: ["ph://SESSION-PHOTO"],
    } );

    const markedUris = getMarkedDevicePhotoUris( {
      objects: () => ( {
        filtered: () => ( [] ),
        forEach: () => undefined,
      } ),
    } );

    expect( markedUris.has( "ph://SESSION-PHOTO" ) ).toBe( true );
  } );
} );
