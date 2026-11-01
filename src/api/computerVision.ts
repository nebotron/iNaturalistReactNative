import inatjs from "inaturalistjs";
import Taxon from "realmModels/Taxon";

import { log } from "../../react-native-logs.config";
import type { ErrorWithResponse } from "./error";
import handleError from "./error";

const logger = log.extend( "computerVision" );

const PARAMS = {
  include_representative_photos: true,
  test_feature: "ancestor_unrestricted",
  fields: {
    combined_score: true,
    vision_score: true,
    taxon: Taxon.LIMITED_TAXON_FIELDS,
  },
};

// `source` and `attempt` only label the timing log line so slow, failed, and
// retried requests can be told apart in the app log.
const scoreImage = async (
  params = {},
  opts = {},
  { source = "unknown", attempt = 1 }: { source?: string; attempt?: number } = {},
): Promise<object> => {
  const start = Date.now( );
  try {
    // Must await so a rejected request is caught here and routed through
    // handleError; a bare `return` would leak the raw inatjs error.
    const response = await inatjs.computervision.score_image( { ...PARAMS, ...params }, opts );
    logger.info(
      `score_image ok ms=${Date.now( ) - start} attempt=${attempt} source=${source}`,
    );
    return response;
  } catch ( e ) {
    const error = e as ErrorWithResponse;
    const status = error.status ?? error.response?.status ?? error.name;
    logger.warn(
      `score_image failed status=${status} ms=${Date.now( ) - start} attempt=${attempt} `
      + `source=${source}`,
    );
    return handleError( error, { context: { functionName: "scoreImage", opts } } );
  }
};

const scoreObservation = async (
  // `id` is the v2 route param, which expects the observation UUID (the v2
  // endpoint converts it to a serial id server-side).
  params: { id: number | string },
  opts = {},
): Promise<object> => {
  try {
    // Must await so a rejected request is caught here and routed through
    // handleError; a bare `return` would leak the raw inatjs error.
    return await inatjs.computervision.score_observation( {
      ...PARAMS,
      ...params,
      fields: {
        ...PARAMS.fields,
        taxon: { ...PARAMS.fields.taxon, is_active: true },
      },
    }, opts );
  } catch ( e ) {
    return handleError( e as Error, { context: { functionName: "scoreObservation", opts } } );
  }
};

export default scoreImage;
export { scoreObservation };
