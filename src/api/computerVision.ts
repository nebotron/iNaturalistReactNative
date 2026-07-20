import inatjs from "inaturalistjs";
import Taxon from "realmModels/Taxon";

import handleError from "./error";

const PARAMS = {
  include_representative_photos: true,
  test_feature: "ancestor_unrestricted",
  fields: {
    combined_score: true,
    vision_score: true,
    taxon: Taxon.LIMITED_TAXON_FIELDS,
  },
};

const scoreImage = async (
  params = {},
  opts = {},
): Promise<object> => {
  try {
    return inatjs.computervision.score_image( { ...PARAMS, ...params }, opts );
  } catch ( e ) {
    return handleError( e as Error, { context: { functionName: "scoreImage", opts } } );
  }
};

const scoreObservation = async (
  params: { id: number },
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
