export interface ExploreTaxonFilter {
  taxon: {
    id: number;
    name?: string;
    preferred_common_name?: string;
    rank?: string;
    rank_level?: number;
    default_photo?: { url?: string };
    iconic_taxon_name?: string;
  };
  exclude: boolean;
}

type TaxonLike = {
  id?: number;
  name?: string;
  preferred_common_name?: string;
  preferredCommonName?: string;
  rank?: string;
  rank_level?: number;
  iconic_taxon_name?: string;
  default_photo?: { url?: string };
  defaultPhoto?: { url?: string };
};

export function toExploreTaxonFilterTaxon(
  taxon: TaxonLike | null | undefined,
): ExploreTaxonFilter["taxon"] {
  if ( !taxon?.id ) {
    throw new Error( "Cannot store taxon filter without taxon id" );
  }

  const defaultPhoto = taxon.default_photo || taxon.defaultPhoto;

  return {
    id: taxon.id,
    name: taxon.name,
    preferred_common_name: taxon.preferred_common_name || taxon.preferredCommonName,
    rank: taxon.rank,
    rank_level: taxon.rank_level,
    iconic_taxon_name: taxon.iconic_taxon_name,
    default_photo: defaultPhoto?.url
      ? { url: defaultPhoto.url }
      : undefined,
  };
}

export function normalizeTaxonFilters(
  taxonFilters: ExploreTaxonFilter[] | undefined,
): ExploreTaxonFilter[] {
  return ( taxonFilters || [] )
    .map( filter => ( {
      exclude: filter.exclude,
      taxon: toExploreTaxonFilterTaxon( filter.taxon ),
    } ) )
    .filter( filter => filter.taxon?.id );
}

export function migrateTaxonFilters(
  storedState: {
    taxon?: ExploreTaxonFilter["taxon"] | null;
    taxon_id?: number | null;
    taxonFilters?: ExploreTaxonFilter[];
  },
): ExploreTaxonFilter[] {
  if ( storedState.taxonFilters?.length ) {
    return normalizeTaxonFilters( storedState.taxonFilters );
  }
  if ( storedState.taxon?.id ) {
    return [{
      taxon: toExploreTaxonFilterTaxon( storedState.taxon ),
      exclude: false,
    }];
  }
  return [];
}

export function taxonFiltersToApiParams(
  taxonFilters: ExploreTaxonFilter[] | undefined,
): {
  taxon_id?: number | string;
  without_taxon_id?: number | string;
} {
  const includeIds = ( taxonFilters || [] )
    .filter( filter => !filter.exclude )
    .map( filter => filter.taxon.id );
  const excludeIds = ( taxonFilters || [] )
    .filter( filter => filter.exclude )
    .map( filter => filter.taxon.id );

  const params: {
    taxon_id?: number | string;
    without_taxon_id?: number | string;
  } = {};

  if ( includeIds.length === 1 ) {
    params.taxon_id = includeIds[0];
  } else if ( includeIds.length > 1 ) {
    params.taxon_id = includeIds.join( "," );
  }

  if ( excludeIds.length === 1 ) {
    params.without_taxon_id = excludeIds[0];
  } else if ( excludeIds.length > 1 ) {
    params.without_taxon_id = excludeIds.join( "," );
  }

  return params;
}

export function toggleTaxonFilter(
  taxonFilters: ExploreTaxonFilter[],
  taxon: ExploreTaxonFilter["taxon"] | TaxonLike,
  exclude = false,
): ExploreTaxonFilter[] {
  const normalizedTaxon = toExploreTaxonFilterTaxon( taxon );
  const existingIndex = taxonFilters.findIndex(
    filter => filter.taxon.id === normalizedTaxon.id,
  );

  if ( existingIndex >= 0 ) {
    const existing = taxonFilters[existingIndex];
    if ( existing.exclude === exclude ) {
      return taxonFilters.filter(
        filter => filter.taxon.id !== normalizedTaxon.id,
      );
    }
    return taxonFilters.map( ( filter, index ) => (
      index === existingIndex
        ? { taxon: normalizedTaxon, exclude }
        : filter
    ) );
  }

  return [...taxonFilters, { taxon: normalizedTaxon, exclude }];
}

export function removeTaxonFilter(
  taxonFilters: ExploreTaxonFilter[],
  taxonId: number,
): ExploreTaxonFilter[] {
  return taxonFilters.filter( filter => filter.taxon.id !== taxonId );
}
