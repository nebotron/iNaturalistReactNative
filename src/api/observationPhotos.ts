import inatjs from "inaturalistjs";

import type { ErrorWithResponse } from "./error";
import handleError from "./error";
import type { ApiOpts } from "./types";

const deleteRemoteObservationPhoto = async ( uuid: string, opts: ApiOpts = {} ) => {
  try {
    return await inatjs.observation_photos.delete( { id: uuid }, opts );
  } catch ( e ) {
    return handleError(
      e as ErrorWithResponse,
      { context: { functionName: "deleteRemoteObservationPhoto", opts } },
    );
  }
};

export default deleteRemoteObservationPhoto;
