import {
  attachUploadFailureDetails,
  formatUploadFailureAlertBody,
  formatHttpResponseBody,
  getHttpStatusText,
  getUploadFailureDetails,
} from "uploaders/utils/uploadFailureDetails";

describe( "uploadFailureDetails", ( ) => {
  beforeEach( ( ) => {
    jest.spyOn( Date, "now" ).mockReturnValue( 2500 );
  } );

  afterEach( ( ) => {
    jest.restoreAllMocks( );
  } );

  describe( "attachUploadFailureDetails", ( ) => {
    test( "should attach stage, duration, HTTP status, and response body", ( ) => {
      const error = new Error( "API Upload Error" );
      error.status = 422;
      error.context = { url: "https://api.inaturalist.org/v1/observations" };
      error.json = {
        error: "Validation failed",
        errors: [{ message: "observation must have a date" }],
      };

      const errorWithDetails = attachUploadFailureDetails(
        error,
        "observation_upload",
        1000,
      );

      expect( errorWithDetails.uploadFailureDetails ).toMatchObject( {
        stage: "observation_upload",
        durationMs: 1500,
        errorName: "Error",
        errorMessage: "API Upload Error",
        httpStatus: 422,
        httpStatusText: "Unprocessable Entity",
        requestUrl: "https://api.inaturalist.org/v1/observations",
        httpResponseBody: JSON.stringify( error.json, null, 2 ),
      } );
      expect( errorWithDetails.uploadFailureDetails?.appState ).toBeTruthy( );
    } );
  } );

  describe( "getUploadFailureDetails", ( ) => {
    test( "should fall back to error fields when details are missing", ( ) => {
      const error = new Error( "Network request failed" );
      error.status = 503;
      error.context = { url: "https://api.inaturalist.org/v1/photos" };
      error.json = { error: "Service unavailable" };

      expect( getUploadFailureDetails( error ) ).toEqual( {
        stage: "unknown",
        durationMs: 0,
        errorName: "Error",
        errorMessage: "Network request failed",
        httpStatus: 503,
        httpStatusText: "Service Unavailable",
        httpResponseBody: JSON.stringify( error.json, null, 2 ),
        requestUrl: "https://api.inaturalist.org/v1/photos",
      } );
    } );
  } );

  describe( "formatUploadFailureAlertBody", ( ) => {
    test( "should include summary, stage, duration, HTTP status, and response body", ( ) => {
      const body = formatUploadFailureAlertBody(
        {
          stage: "media_upload",
          durationMs: 842,
          errorName: "Error",
          errorMessage: "Media upload failed: timeout",
          httpStatus: 408,
          httpStatusText: "Request Timeout",
          httpResponseBody: '{\n  "error": "timeout"\n}',
          requestUrl: "https://api.inaturalist.org/v1/photos",
        },
        "Connection problem. Please try again later.",
      );

      expect( body ).toContain( "Connection problem. Please try again later." );
      expect( body ).toContain( "Stage: media_upload" );
      expect( body ).toContain( "Duration: 842 ms" );
      expect( body ).toContain( "HTTP status: 408 Request Timeout" );
      expect( body ).toContain( "HTTP response body:" );
      expect( body ).toContain( '"error": "timeout"' );
      expect( body ).toContain(
        "Request URL: https://api.inaturalist.org/v1/photos",
      );
      expect( body ).toContain( "Details: Media upload failed: timeout" );
    } );
  } );

  describe( "formatHttpResponseBody", ( ) => {
    test( "should stringify API error JSON", ( ) => {
      const error = new Error( "ignored" );
      error.json = { error: "Validation failed" };

      expect( formatHttpResponseBody( error ) ).toBe(
        JSON.stringify( error.json, null, 2 ),
      );
    } );
  } );

  describe( "getHttpStatusText", ( ) => {
    test( "should return known status text", ( ) => {
      expect( getHttpStatusText( 422 ) ).toBe( "Unprocessable Entity" );
    } );

    test( "should return generic text for unknown status codes", ( ) => {
      expect( getHttpStatusText( 418 ) ).toBe( "HTTP 418" );
    } );
  } );
} );
