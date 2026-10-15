import {
  appendPhotosToObservation,
  buildGroupedMediaItems,
  createObservationFromGroupedMedia,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import Observation from "realmModels/Observation";

jest.mock( "realmModels/Observation", ( ) => ( {
  new: jest.fn( ( ) => Promise.resolve( { observationSounds: [] } ) ),
  createObservationWithPhotos: jest.fn( ( ) => Promise.resolve( {
    observationPhotos: [],
    observationSounds: [],
  } ) ),
  updateObsExifFromPhotos: jest.fn( ( _uris, observation ) => Promise.resolve( observation ) ),
  appendObsPhotos: jest.fn( ( obsPhotos, observation ) => ( {
    ...observation,
    observationPhotos: [
      ...( observation.observationPhotos || [] ),
      ...obsPhotos,
    ],
  } ) ),
} ) );

jest.mock( "realmModels/ObservationPhoto", ( ) => ( {
  createObsPhotosWithPosition: jest.fn( photos => Promise.resolve( photos ) ),
} ) );

describe( "photoLibraryMediaHelpers", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  describe( "buildGroupedMediaItems", ( ) => {
    it( "should create one group per photo", ( ) => {
      expect( buildGroupedMediaItems(
        [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
      ) ).toEqual( [
        { photos: [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }] },
      ] );
    } );
  } );

  describe( "createObservationFromGroupedMedia", ( ) => {
    it( "should create a photo observation from a photo group", async ( ) => {
      await createObservationFromGroupedMedia( {
        photos: [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
      } );

      expect( Observation.createObservationWithPhotos ).toHaveBeenCalled( );
    } );
  } );

  describe( "appendPhotosToObservation", ( ) => {
    it( "should append photos to an existing observation", async ( ) => {
      const updatedObservation = await appendPhotosToObservation(
        [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
        { observationPhotos: [], observationSounds: [] },
        0,
      );

      expect( Observation.appendObsPhotos ).toHaveBeenCalled( );
      expect( updatedObservation.observationPhotos ).toHaveLength( 1 );
    } );
  } );
} );
