// @flow

import inatjs from "inaturalistjs";
import Identification from "realmModels/Identification";
import rison from "rison-node";

import handleError from "./error";

class FetchResponseError extends Error {
  response: Object;
}

const PARAMS = {
  fields: Identification.ID_FIELDS,
};

const createIdentification = async (
  params: Object = {},
  opts: Object = {},
): Promise<?Object> => {
  try {
    const { results } = await inatjs.identifications.create( { ...PARAMS, ...params }, opts );
    return results;
  } catch ( e ) {
    return handleError( e, { context: { functionName: "createIdentification", opts } } );
  }
};

const updateIdentification = async (
  params: Object = {},
  opts: Object = {},
): Promise<?Object> => {
  try {
    const { results } = await inatjs.identifications.update( { ...PARAMS, ...params }, opts );
    return results;
  } catch ( e ) {
    return handleError( e, { context: { functionName: "updateIdentification", opts } } );
  }
};

// inaturalistjs doesn't have a client method for GET /v1/identifications,
// so this hits the API directly, mirroring how inaturalistjs builds its own
// authenticated GET requests (rison-encoded fields, JWT in Authorization).
const searchIdentifications = async (
  params: Object = {},
  opts: Object = {},
): Promise<?Object> => {
  try {
    const { fields, ...queryParams } = params;
    const searchParams = new URLSearchParams( );
    Object.entries( queryParams ).forEach( ( [key, value] ) => {
      if ( value !== undefined && value !== null ) {
        searchParams.append( key, String( value ) );
      }
    } );
    if ( fields ) {
      searchParams.append( "fields", rison.encode( fields ) );
    }
    const headers: { [key: string]: string } = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if ( opts.api_token ) {
      headers.Authorization = opts.api_token;
    }
    const response = await fetch(
      `https://api.inaturalist.org/v1/identifications?${searchParams.toString( )}`,
      { headers },
    );
    if ( !response.ok ) {
      const error = new FetchResponseError( `Failed to fetch identifications: ${response.status}` );
      error.response = response;
      throw error;
    }
    return await response.json( );
  } catch ( e ) {
    return handleError( e, { context: { functionName: "searchIdentifications", opts } } );
  }
};

export {
  createIdentification,
  searchIdentifications,
  updateIdentification,
};
