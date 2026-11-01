import * as apiObservations from "api/observations";
import * as authService from "components/LoginSignUp/AuthenticationService";
import factory from "tests/factory";
import prepareObservationForUpload from "uploaders/dataTransformation/prepareObservationForUpload";
import * as mediaUploader from "uploaders/mediaUploader";
import uploadObservation from "uploaders/observationUploader";
import syncProjectChildDeletions from "uploaders/projectChildrenDeleter";
import * as projectChildrenUploader from "uploaders/projectChildrenUploader";
import { RECOVERY_BY } from "uploaders/utils/errorHandling";
import * as progressTracker from "uploaders/utils/progressTracker";
import markRecordUploaded from "uploaders/utils/realmSync";

const mockErrorWithExtra = jest.fn();
jest.mock( "sharedHelpers/logger", () => {
  const makeLogger = () => ( {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    // Delegate lazily: this logger is bound at module load, before the
    // mockErrorWithExtra const above has initialized.
    errorWithExtra: ( ...args ) => mockErrorWithExtra( ...args ),
    extend: () => makeLogger(),
  } );
  const log = makeLogger();
  return { log };
} );

jest.mock( "components/LoginSignUp/AuthenticationService" );
jest.mock( "uploaders/utils/progressTracker" );
jest.mock( "uploaders/mediaUploader" );
jest.mock( "uploaders/projectChildrenDeleter" );
jest.mock( "uploaders/projectChildrenUploader" );
jest.mock( "uploaders/dataTransformation/prepareObservationForUpload" );
jest.mock( "uploaders/utils/realmSync" );
jest.mock( "api/observations" );
jest.mock( "sharedHelpers/safeRealmWrite", () => jest.fn() );
jest.mock( "realmModels/Observation", () => {
  const actual = jest.requireActual( "realmModels/Observation" );
  actual.default.upsertRemoteObservations = jest.fn();
  return actual;
} );

describe( "uploadObservation", () => {
  let mockObservation;
  let mockRealm;
  let mockProgressTracker;
  let mockMediaItems;

  beforeEach( () => {
    jest.clearAllMocks();

    mockObservation = factory( "LocalObservation", {
      uuid: "test-uuid-123",
    } );
    mockObservation.wasSynced = jest.fn( () => false );

    mockRealm = {
      objectForPrimaryKey: jest.fn( () => factory( "LocalObservation" ) ),
    };

    mockProgressTracker = {
      start: jest.fn(),
      complete: jest.fn(),
      error: jest.fn(),
    };

    mockMediaItems = {
      unsyncedObservationPhotos: [],
      modifiedObservationPhotos: [],
      unsyncedObservationSounds: [],
    };

    authService.getJWT.mockResolvedValue( "test-json-web-token" );
    progressTracker.trackObservationUpload.mockReturnValue( mockProgressTracker );

    // Mock the new functions in mediaUploader
    mediaUploader.uploadObservationMedia.mockResolvedValue( mockMediaItems );
    mediaUploader.attachMediaToObservation.mockResolvedValue( undefined );

    prepareObservationForUpload.mockReturnValue( {
      uuid: mockObservation.uuid,
      taxon_id: 12345,
    } );

    apiObservations.createObservation.mockResolvedValue( {
      results: [{ uuid: mockObservation.uuid, id: 12345 }],
    } );

    apiObservations.updateObservation.mockResolvedValue( {
      results: [{ uuid: mockObservation.uuid, id: 12345 }],
    } );

    syncProjectChildDeletions.mockResolvedValue( undefined );
    projectChildrenUploader.uploadProjectChildren.mockResolvedValue( undefined );
  } );

  it( "should start and complete progress tracking", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( progressTracker.trackObservationUpload ).toHaveBeenCalledWith( mockObservation.uuid );
    expect( mockProgressTracker.start ).toHaveBeenCalled();
    expect( mockProgressTracker.complete ).toHaveBeenCalled();
  } );

  it( "should validate the API token", async () => {
    await uploadObservation( mockObservation, mockRealm );
    expect( authService.getJWT ).toHaveBeenCalled();
  } );

  it( "should throw an error if no API token is available", async () => {
    authService.getJWT.mockResolvedValue( null );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "Gack, tried to upload an observation without API token!" );
  } );

  it( "should ask for login again when there is no token and no signed-in user", async () => {
    authService.getJWT.mockResolvedValue( null );
    authService.isLoggedIn.mockResolvedValue( false );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toMatchObject( { recoveryBy: RECOVERY_BY.LOGIN_AGAIN } );
  } );

  it( "should not ask a signed-in user to log in again when the token refresh failed", async () => {
    // The user's credentials are fine; the refresh just didn't come back.
    authService.getJWT.mockResolvedValue( null );
    authService.isLoggedIn.mockResolvedValue( true );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toMatchObject( { recoveryBy: undefined } );
  } );

  it( "should prepare the observation for upload", async () => {
    await uploadObservation( mockObservation, mockRealm );
    expect( prepareObservationForUpload ).toHaveBeenCalledWith( mockObservation );
  } );

  it( "should create a new observation if it was not previously synced", async () => {
    mockObservation.wasSynced.mockReturnValue( false );

    await uploadObservation( mockObservation, mockRealm );

    expect( apiObservations.createObservation ).toHaveBeenCalledWith(
      expect.objectContaining( {
        observation: expect.anything(),
        fields: { id: true },
      } ),
      expect.objectContaining( { api_token: "test-json-web-token" } ),
    );
    expect( apiObservations.updateObservation ).not.toHaveBeenCalled();
  } );

  it( "should update an existing observation if it was previously synced", async () => {
    mockObservation.wasSynced.mockReturnValue( true );

    await uploadObservation( mockObservation, mockRealm );

    expect( apiObservations.updateObservation ).toHaveBeenCalledWith(
      expect.objectContaining( {
        observation: expect.anything(),
        fields: { id: true },
        id: mockObservation.uuid,
        ignore_photos: true,
      } ),
      expect.objectContaining( { api_token: "test-json-web-token" } ),
    );
    expect( apiObservations.createObservation ).not.toHaveBeenCalled();
  } );

  it( "should call uploadObservationMedia with correct parameters", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( mediaUploader.uploadObservationMedia ).toHaveBeenCalledWith(
      mockObservation,
      expect.objectContaining( { api_token: "test-json-web-token" } ),
      mockRealm,
    );
  } );

  it(
    "should call attachMediaToObservation with correct parameters after observation creation",
    async () => {
      await uploadObservation( mockObservation, mockRealm );

      expect( mediaUploader.attachMediaToObservation ).toHaveBeenCalledWith(
        mockObservation.uuid,
        mockMediaItems,
        expect.objectContaining( { api_token: "test-json-web-token" } ),
        mockRealm,
      );
    },
  );

  it( "should call syncProjectChildDeletions before uploadProjectChildren", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( syncProjectChildDeletions ).toHaveBeenCalledWith(
      mockObservation,
      expect.objectContaining( { api_token: "test-json-web-token" } ),
      mockRealm,
    );
    expect( projectChildrenUploader.uploadProjectChildren ).toHaveBeenCalledWith(
      mockObservation.uuid,
      mockObservation,
      expect.objectContaining( { api_token: "test-json-web-token" } ),
      mockRealm,
    );
    expect(
      syncProjectChildDeletions.mock.invocationCallOrder[0],
    ).toBeLessThan(
      projectChildrenUploader.uploadProjectChildren.mock.invocationCallOrder[0],
    );
  } );

  it( "should skip project children create when observation upload returns no uuid", async () => {
    apiObservations.createObservation.mockResolvedValue( {
      results: [{ id: 12345 }],
    } );

    await uploadObservation( mockObservation, mockRealm );

    expect( syncProjectChildDeletions ).toHaveBeenCalled( );
    expect( projectChildrenUploader.uploadProjectChildren ).not.toHaveBeenCalled( );
    expect( markRecordUploaded ).toHaveBeenCalled( );
  } );

  it( "should call uploadProjectChildren after media is attached", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( projectChildrenUploader.uploadProjectChildren ).toHaveBeenCalledWith(
      mockObservation.uuid,
      mockObservation,
      expect.objectContaining( { api_token: "test-json-web-token" } ),
      mockRealm,
    );
  } );

  it( "should mark the record as uploaded after project children upload", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( projectChildrenUploader.uploadProjectChildren ).toHaveBeenCalled();
    expect( markRecordUploaded ).toHaveBeenCalledWith(
      mockObservation.uuid,
      null,
      "Observation",
      expect.anything(),
      mockRealm,
    );
    const childrenCallOrder = projectChildrenUploader.uploadProjectChildren
      .mock.invocationCallOrder[0];
    const markCallOrder = markRecordUploaded.mock.invocationCallOrder[0];
    expect( childrenCallOrder ).toBeLessThan( markCallOrder );
  } );

  it( "should throw an error if project children delete fails", async () => {
    syncProjectChildDeletions
      .mockRejectedValue( new Error( "Project Children Delete Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "Project Children Delete Error" );
    expect( projectChildrenUploader.uploadProjectChildren ).not.toHaveBeenCalled( );
    expect( markRecordUploaded ).not.toHaveBeenCalled( );
  } );

  it( "should throw an error if project children upload fails", async () => {
    projectChildrenUploader.uploadProjectChildren
      .mockRejectedValue( new Error( "Project Children Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "Project Children Error" );
    expect( markRecordUploaded ).not.toHaveBeenCalled();
  } );

  it( "should mark the record as uploaded after media is attached", async () => {
    await uploadObservation( mockObservation, mockRealm );

    expect( markRecordUploaded ).toHaveBeenCalledWith(
      mockObservation.uuid,
      null,
      "Observation",
      expect.anything(),
      mockRealm,
    );
  } );

  it( "should return the API response", async () => {
    const mockResponse = { results: [{ uuid: mockObservation.uuid }] };
    apiObservations.createObservation.mockResolvedValue( mockResponse );

    const result = await uploadObservation( mockObservation, mockRealm );

    expect( result ).toEqual( mockResponse );
  } );

  it( "should throw an error if observation creation fails", async () => {
    apiObservations.createObservation.mockRejectedValue( new Error( "API Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "API Error" );
  } );

  it( "should throw an error if media upload fails", async () => {
    mediaUploader.uploadObservationMedia.mockRejectedValue( new Error( "Media Upload Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "Media Upload Error" );
  } );

  it( "should log structured upload-failure diagnostics as extra", async () => {
    // A 413 (payload too large) from the photos endpoint should surface its
    // HTTP status in the remote log rather than being flattened to a string.
    const apiError = Object.assign( new Error( "Payload Too Large" ), { status: 413 } );
    mediaUploader.uploadObservationMedia.mockRejectedValue( apiError );

    await expect( uploadObservation( mockObservation, mockRealm ) ).rejects.toThrow();

    // The last argument must be the structured details object so the Firebase
    // transport records its fields instead of stringifying it to "[object Object]".
    const call = mockErrorWithExtra.mock.calls.find(
      args => args[0]?.includes( "media_upload" ),
    );
    expect( call ).toBeDefined();
    const details = call.at( -1 );
    expect( details.stage ).toBe( "media_upload" );
    expect( details.httpStatus ).toBe( 413 );
    expect( details.httpStatusText ).toBeDefined();
  } );

  it( "should throw an error if media attachment fails", async () => {
    mediaUploader.attachMediaToObservation
      .mockRejectedValue( new Error( "Media Attachment Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "Media Attachment Error" );
  } );

  it( "should not complete progress tracking when errors occur", async () => {
    apiObservations.createObservation.mockRejectedValue( new Error( "API Error" ) );

    await expect( uploadObservation( mockObservation, mockRealm ) ).rejects.toThrow( "API Error" );
    expect( mockProgressTracker.complete ).not.toHaveBeenCalled();
  } );

  it( "should throw an error when observation creation returns null response", async () => {
    apiObservations.createObservation.mockResolvedValue( null );

    await expect( uploadObservation( mockObservation, mockRealm ) )
      .rejects.toThrow( "No response from observation upload" );

    // Should not attempt to attach media or mark as uploaded
    expect( mediaUploader.attachMediaToObservation ).not.toHaveBeenCalled();
    expect( markRecordUploaded ).not.toHaveBeenCalled();
  } );

  it( "should pass custom options to API calls", async () => {
    const customOpts = { locale: "es-ES" };

    await uploadObservation( mockObservation, mockRealm, customOpts );

    expect( apiObservations.createObservation ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining( {
        api_token: "test-json-web-token",
        locale: "es-ES",
      } ),
    );
  } );
} );
