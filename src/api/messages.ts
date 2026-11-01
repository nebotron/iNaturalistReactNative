import inatjs from "inaturalistjs";
import User from "realmModels/User";

import handleError from "./error";

const MESSAGE_FIELDS = {
  id: true,
  created_at: true,
  read_at: true,
  subject: true,
  body: true,
  from_user: User.FIELDS,
  to_user: User.FIELDS,
};

const PARAMS = {
  fields: MESSAGE_FIELDS,
};

const searchMessages = async ( params: object = {}, opts: object = {} ): Promise<object> => {
  try {
    const { results } = await inatjs.messages.search( { ...PARAMS, ...params }, opts );
    return results;
  } catch ( e ) {
    return handleError( e as Error, { context: { functionName: "searchMessages", opts } } );
  }
};

export default searchMessages;
