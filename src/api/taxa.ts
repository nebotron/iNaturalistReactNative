import inatjs from "inaturalistjs";

import type { ErrorWithResponse } from "./error";
import handleError from "./error";
import type { ApiOpts, ApiPhotoWithLicense, ApiUntypedParams } from "./types";

const ANCESTOR_FIELDS = {
  id: true,
  name: true,
  preferred_common_name: true,
  rank: true,
  rank_level: true,
};

const PHOTO_FIELDS = {
  id: true,
  attribution: true,
  license_code: true,
  url: true,
};

// These fields should work with all /taxa endpoints
const FIELDS = {
  ancestor_ids: true,
  default_photo: {
    url: true,
  },
  iconic_taxon_name: true,
  name: true,
  preferred_common_name: true,
  rank: true,
  rank_level: true,
  wikipedia_url: true,
};

const PARAMS = {
  fields: FIELDS,
};

interface RemoteTaxonWithPhotos {
  taxonPhotos?: ApiPhotoWithLicense[];
  taxon_photos?: ApiPhotoWithLicense[];
}

function mapTaxonPhotoToLocalSchema<T extends ApiPhotoWithLicense>( taxonPhoto: T ): T {
  taxonPhoto.photo.licenseCode = taxonPhoto.photo.licenseCode
    || taxonPhoto.photo.license_code;
  return taxonPhoto;
}
function mapToLocalSchema<T extends RemoteTaxonWithPhotos>( taxon: T ): T {
  taxon.taxonPhotos = taxon?.taxonPhotos?.map( mapTaxonPhotoToLocalSchema );
  taxon.taxon_photos = taxon?.taxon_photos?.map( mapTaxonPhotoToLocalSchema );
  return taxon;
}

async function fetchTaxon(
  id: number | number[],
  params: ApiUntypedParams = {},
  opts: ApiOpts = {},
) {
  try {
    const fetchParams = {
      ...PARAMS,
      ...params,
      fields: {
        ...FIELDS,
        ancestors: ANCESTOR_FIELDS,
        children: ANCESTOR_FIELDS,
        establishment_means: {
          establishment_means: true,
          id: true,
          place: {
            id: true,
            display_name: true,
          },
        },
        listed_taxa: {
          establishment_means: true,
          id: true,
          list: {
            title: true,
          },
          place: {
            id: true,
          },
        },
        taxon_photos: {
          photo: PHOTO_FIELDS,
        },
        wikipedia_summary: true,
      },
    };
    const response = await inatjs.taxa.fetch( id, fetchParams, opts );
    if ( typeof id === "number" ) {
      const results = response?.results;
      if ( !results || results.length === 0 ) return null;

      return mapToLocalSchema( results[0] );
    }
    return response;
  } catch ( e ) {
    return handleError(
      e as ErrorWithResponse,
      { context: { functionName: "fetchTaxon", id, opts } },
    );
  }
}

// Global observation counts for a batch of taxa. Deliberately does not go
// through fetchTaxon: this can run over every species a user has seen, so it
// asks for the two fields it needs instead of ancestors, photos and summaries.
async function fetchTaxaObservationsCounts(
  ids: number[],
  opts: ApiOpts = {},
) {
  try {
    const response = await inatjs.taxa.fetch( ids, {
      fields: { id: true, observations_count: true },
    }, opts );
    return response?.results || [];
  } catch ( e ) {
    return handleError( e, {
      context: { functionName: "fetchTaxaObservationsCounts", ids, opts },
    } );
  }
}

// Default photos for a batch of taxa, for lists that would otherwise fetch
// each taxon in full at once and get rate limited
async function fetchTaxaDefaultPhotos(
  ids: number[],
  opts: ApiOpts = {},
) {
  try {
    const response = await inatjs.taxa.fetch( ids, {
      fields: { id: true, default_photo: { url: true } },
    }, opts );
    return response?.results || [];
  } catch ( e ) {
    return handleError( e as ErrorWithResponse, {
      context: { functionName: "fetchTaxaDefaultPhotos", ids, opts },
    } );
  }
}

async function searchTaxa( params: ApiUntypedParams = {}, opts: ApiOpts = {} ) {
  try {
    const searchParams = { ...PARAMS, ...params };
    const { results } = await inatjs.taxa.search( searchParams, opts );
    return results;
  } catch ( e ) {
    return handleError( e as ErrorWithResponse, { context: { functionName: "searchTaxa", opts } } );
  }
}

export {
  fetchTaxaDefaultPhotos,
  fetchTaxaObservationsCounts,
  fetchTaxon,
  searchTaxa,
};
