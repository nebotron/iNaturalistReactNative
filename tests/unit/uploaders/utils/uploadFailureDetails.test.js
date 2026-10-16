import {
  attachUploadFailureDetails,
  formatHttpResponseBody,
  getHttpStatusText,
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
