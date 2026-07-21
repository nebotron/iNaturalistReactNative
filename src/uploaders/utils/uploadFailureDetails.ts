import type { INatApiError } from "api/error";
import { AppState } from "react-native";

export interface UploadFailureDetails {
  stage: string;
  durationMs: number;
  errorName: string;
  errorMessage: string;
  httpStatus?: number;
  httpStatusText?: string;
  httpResponseBody?: string;
  requestUrl?: string;
  appState?: string;
}

export type ErrorWithUploadFailureDetails = Error & {
  uploadFailureDetails?: UploadFailureDetails;
};

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  410: "Gone",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export const getHttpStatusText = ( status?: number ): string | undefined => (
  status
    ? HTTP_STATUS_TEXT[status] || `HTTP ${status}`
    : undefined
);

const MAX_HTTP_RESPONSE_BODY_LENGTH = 8000;

export const formatHttpResponseBody = (
  apiError: INatApiError | Error,
): string | undefined => {
  const inatError = apiError as INatApiError;

  if ( inatError.json ) {
    try {
      return JSON.stringify( inatError.json, null, 2 );
    } catch {
      return String( inatError.json );
    }
  }

  if ( typeof inatError.status === "number" && apiError.message ) {
    try {
      return JSON.stringify( JSON.parse( apiError.message ), null, 2 );
    } catch {
      return apiError.message;
    }
  }

  return undefined;
};

const truncateHttpResponseBody = ( body: string ): string => {
  if ( body.length <= MAX_HTTP_RESPONSE_BODY_LENGTH ) {
    return body;
  }

  return `${body.slice( 0, MAX_HTTP_RESPONSE_BODY_LENGTH )}\n…`;
};

export const attachUploadFailureDetails = (
  error: Error,
  stage: string,
  uploadStartTime: number,
): ErrorWithUploadFailureDetails => {
  const durationMs = Date.now() - uploadStartTime;
  const apiError = error as INatApiError;
  const httpStatus = typeof apiError.status === "number"
    ? apiError.status
    : undefined;
  const httpResponseBody = formatHttpResponseBody( apiError );

  const uploadFailureDetails: UploadFailureDetails = {
    appState: AppState.currentState,
    stage,
    durationMs,
    errorName: error.name || "Error",
    errorMessage: error.message,
    httpStatus,
    httpStatusText: httpStatus
      ? getHttpStatusText( httpStatus )
      : undefined,
    httpResponseBody: httpResponseBody
      ? truncateHttpResponseBody( httpResponseBody )
      : undefined,
  };

  if ( apiError.context?.url ) {
    uploadFailureDetails.requestUrl = String( apiError.context.url );
  }

  const errorWithDetails = error as ErrorWithUploadFailureDetails;
  errorWithDetails.uploadFailureDetails = uploadFailureDetails;
  return errorWithDetails;
};

export const getUploadFailureDetails = (
  error: ErrorWithUploadFailureDetails,
): UploadFailureDetails => {
  if ( error.uploadFailureDetails ) {
    return error.uploadFailureDetails;
  }

  const apiError = error as INatApiError;
  const httpResponseBody = formatHttpResponseBody( error );

  return {
    stage: "unknown",
    durationMs: 0,
    errorName: error.name || "Error",
    errorMessage: error.message,
    httpStatus: apiError.status,
    httpStatusText: getHttpStatusText( apiError.status ),
    httpResponseBody: httpResponseBody
      ? truncateHttpResponseBody( httpResponseBody )
      : undefined,
    requestUrl: apiError.context?.url
      ? String( apiError.context.url )
      : undefined,
  };
};

export const formatUploadFailureAlertBody = (
  details: UploadFailureDetails,
  summaryMessage: string,
): string => {
  const lines = [
    summaryMessage,
    "",
    `Stage: ${details.stage}`,
    `Duration: ${details.durationMs} ms`,
  ];

  if ( details.httpStatus ) {
    lines.push(
      `HTTP status: ${details.httpStatus}${
        details.httpStatusText
          ? ` ${details.httpStatusText}`
          : ""
      }`,
    );
  }

  if ( details.httpResponseBody ) {
    lines.push( "HTTP response body:", details.httpResponseBody );
  }

  if ( details.requestUrl ) {
    lines.push( `Request URL: ${details.requestUrl}` );
  }

  if ( details.appState ) {
    lines.push( `App state: ${details.appState}` );
  }

  lines.push(
    `Error type: ${details.errorName}`,
    `Details: ${details.errorMessage}`,
  );

  return lines.join( "\n" );
};
