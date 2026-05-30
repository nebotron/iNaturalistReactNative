import {
  appendPhotosAndVideoSoundsToObservation,
  appendVideoSoundsToObservation,
  applyMediaMetadataToObservation,
  buildGroupedMediaItems,
  createObservationFromGroupedMedia,
  createObservationWithPhotosAndVideoSounds,
  createObservationWithVideoSounds,
  isVideoAsset,
  mergeMediaMetadata,
  partitionAssetsByMediaType,
  readMetadataFromMovedVideos,
} from "components/PhotoImporter/helpers/photoLibraryMediaHelpers";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import extractAudioFromVideo from "sharedHelpers/extractAudioFromVideo";
import { readMetadataFromMultipleVideos } from "sharedHelpers/readVideoMetadata";

jest.mock( "sharedHelpers/extractAudioFromVideo", ( ) => jest.fn( ) );
jest.mock( "sharedHelpers/readVideoMetadata", ( ) => ( {
  readMetadataFromMultipleVideos: jest.fn( ( ) => Promise.resolve( {} ) ),
} ) );
jest.mock( "sharedHelpers/parseExif", ( ) => jest.fn( ( ) => Promise.resolve( {} ) ) );

jest.mock( "realmModels/Observation", ( ) => ( {
  new: jest.fn( ( ) => Promise.resolve( { observationSounds: [] } ) ),
  appendObsSounds: jest.fn( ( obsSounds, observation ) => ( {
    ...observation,
    observationSounds: [
      ...( observation.observationSounds || [] ),
      ...obsSounds,
    ],
  } ) ),
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

jest.mock( "realmModels/ObservationSound", ( ) => ( {
  new: jest.fn( uri => Promise.resolve( {
    uuid: `sound-${uri}`,
    sound: { file_url: uri },
  } ) ),
} ) );

describe( "photoLibraryMediaHelpers", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    extractAudioFromVideo.mockImplementation(
      videoUri => Promise.resolve( `file://audio/${videoUri}` ),
    );
    readMetadataFromMultipleVideos.mockResolvedValue( {
      latitude: 12.34,
      longitude: 56.78,
      observed_on_string: "2024-01-01T12:00:00",
    } );
  } );

  describe( "isVideoAsset", ( ) => {
    it( "should identify video assets", ( ) => {
      expect( isVideoAsset( { type: "video/mp4" } ) ).toBe( true );
    } );

    it( "should not identify photo assets as video", ( ) => {
      expect( isVideoAsset( { type: "image/jpeg" } ) ).toBe( false );
    } );
  } );

  describe( "partitionAssetsByMediaType", ( ) => {
    it( "should split photos and videos", ( ) => {
      const photo = { type: "image/jpeg", uri: "photo.jpg" };
      const video = { type: "video/mp4", uri: "video.mp4" };

      expect( partitionAssetsByMediaType( [photo, video] ) ).toEqual( {
        photoAssets: [photo],
        videoAssets: [video],
      } );
    } );
  } );

  describe( "mergeMediaMetadata", ( ) => {
    it( "should prefer the first available values", ( ) => {
      expect( mergeMediaMetadata(
        { latitude: 1, longitude: 2 },
        { latitude: 3, longitude: 4, observed_on_string: "2024-01-01" },
      ) ).toEqual( {
        latitude: 1,
        longitude: 2,
        observed_on_string: "2024-01-01",
      } );
    } );
  } );

  describe( "applyMediaMetadataToObservation", ( ) => {
    it( "should apply missing location fields to an observation", ( ) => {
      const updatedObservation = applyMediaMetadataToObservation(
        {},
        {
          latitude: 12.34,
          longitude: 56.78,
          observed_on_string: "2024-01-01T12:00:00",
        },
      );

      expect( updatedObservation ).toEqual( {
        latitude: 12.34,
        longitude: 56.78,
        observed_on_string: "2024-01-01T12:00:00",
      } );
    } );
  } );

  describe( "buildGroupedMediaItems", ( ) => {
    it( "should create one group per photo and one group per video", ( ) => {
      expect( buildGroupedMediaItems(
        [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
        [{ uri: "file://video.mp4", asset: { type: "video/mp4" } }],
      ) ).toEqual( [
        { photos: [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }] },
        { videos: [{ uri: "file://video.mp4", asset: { type: "video/mp4" } }] },
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

    it( "should create a sound observation from a video group", async ( ) => {
      await createObservationFromGroupedMedia( {
        videos: [{ uri: "file://video.mp4", asset: { type: "video/mp4" } }],
      } );

      expect( extractAudioFromVideo ).toHaveBeenCalled( );
    } );
  } );

  describe( "createObservationWithVideoSounds", ( ) => {
    it( "should extract audio from each video and attach sounds with metadata", async ( ) => {
      const observation = await createObservationWithVideoSounds( [{
        uri: "file://video/one.mp4",
        asset: { type: "video/mp4", id: "abc" },
      }] );

      expect( extractAudioFromVideo ).toHaveBeenCalledWith( "file://video/one.mp4" );
      expect( readMetadataFromMultipleVideos ).toHaveBeenCalledWith( [{
        uri: "file://video/one.mp4",
        assetId: "abc",
      }] );
      expect( observation.observationSounds ).toHaveLength( 1 );
      expect( observation.latitude ).toBe( 12.34 );
      expect( observation.longitude ).toBe( 56.78 );
    } );
  } );

  describe( "createObservationWithPhotosAndVideoSounds", ( ) => {
    it( "should create an observation with both photos and sounds", async ( ) => {
      const observation = await createObservationWithPhotosAndVideoSounds(
        [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
        [{ uri: "file://video/one.mp4", asset: { type: "video/mp4" } }],
      );

      expect( Observation.createObservationWithPhotos ).toHaveBeenCalled( );
      expect( observation.observationSounds ).toHaveLength( 1 );
    } );
  } );

  describe( "appendVideoSoundsToObservation", ( ) => {
    it( "should append extracted sounds to an existing observation", async ( ) => {
      const currentObservation = {
        observationSounds: [{ uuid: "existing" }],
      };

      const updatedObservation = await appendVideoSoundsToObservation(
        [{ uri: "file://video/one.mp4", asset: { type: "video/mp4" } }],
        currentObservation,
      );

      expect( Observation.appendObsSounds ).toHaveBeenCalled( );
      expect( updatedObservation.observationSounds ).toHaveLength( 2 );
      expect( updatedObservation.latitude ).toBe( 12.34 );
    } );
  } );

  describe( "appendPhotosAndVideoSoundsToObservation", ( ) => {
    it( "should append both photos and sounds to an existing observation", async ( ) => {
      const updatedObservation = await appendPhotosAndVideoSoundsToObservation(
        [{ image: { uri: "file://photo.jpg", type: "image/jpeg" } }],
        [{ uri: "file://video/one.mp4", asset: { type: "video/mp4" } }],
        { observationPhotos: [], observationSounds: [] },
        0,
      );

      expect( Observation.appendObsPhotos ).toHaveBeenCalled( );
      expect( Observation.appendObsSounds ).toHaveBeenCalled( );
      expect( updatedObservation.observationPhotos ).toHaveLength( 1 );
      expect( updatedObservation.observationSounds ).toHaveLength( 1 );
    } );
  } );

  describe( "readMetadataFromMovedVideos", ( ) => {
    it( "should pass asset ids through to the native metadata reader", async ( ) => {
      await readMetadataFromMovedVideos( [{
        uri: "file://video/one.mp4",
        asset: { type: "video/mp4", id: "abc" },
      }] );

      expect( readMetadataFromMultipleVideos ).toHaveBeenCalledWith( [{
        uri: "file://video/one.mp4",
        assetId: "abc",
      }] );
    } );
  } );
} );
