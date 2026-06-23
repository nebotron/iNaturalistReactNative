import inatjs from "inaturalistjs";

import handleError from "./error";

interface ExemplarIdentificationsParams {
  direct_taxon_id?: number;
  order_by?: "id" | "created_at" | "votes" | "word_count";
  order?: "asc" | "desc";
  per_page?: number;
  page?: number;
  fields?: object;
}

const fetchExemplarIdentifications = async (
  params: ExemplarIdentificationsParams = {},
  opts: object = {},
): Promise<object | null> => {
  try {
    const response = await inatjs.exemplar_identifications.search( params, opts );
    return response;
  } catch ( e ) {
    return handleError( e, {
      context: { functionName: "fetchExemplarIdentifications", opts },
    } );
  }
};

export default fetchExemplarIdentifications;
