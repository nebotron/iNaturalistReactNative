// Sorting observations into taxonomic order: the same species together, species grouped by
// genus, genera by subfamily, family and so on up, with every intermediate rank (complex,
// section, tribe, ...) taken into account. Equivalent to sorting by each observation's full
// lineage of scientific names, compared one rank at a time.

// Realm query for observations of a taxon and all its descendants, like the API's taxon_id
export const TAXON_AND_DESCENDANTS_QUERY = "taxon.id == $0 OR taxon.ancestor_ids == $0";

export interface LineageTaxon {
  id: number;
  ancestor_ids?: ArrayLike<number> | null;
}

// One taxon in a lineage. The name is missing when it hasn't been resolved yet, in which case
// the id still keeps the taxon's descendants together
export interface LineageStep {
  id: number;
  name?: string;
}

// Root-to-tip ids of a taxon's lineage, ending with the taxon itself. ancestor_ids from the API
// include the taxon's own id for some taxa and not others, so it's dropped and re-appended
export function taxonLineageIds( taxon: LineageTaxon ): number[] {
  const ancestorIds = Array.from( taxon.ancestor_ids || [] )
    .map( Number )
    .filter( id => id !== taxon.id );
  return [...ancestorIds, taxon.id];
}

// Siblings sort by name, case-insensitively. Taxa whose names aren't known yet go after their
// named siblings, so a partially resolved list only shuffles at the end
function compareSteps( a: LineageStep, b: LineageStep ): number {
  if ( a.name && b.name ) {
    const aName = a.name.toLowerCase( );
    const bName = b.name.toLowerCase( );
    if ( aName !== bName ) {
      return aName < bName
        ? -1
        : 1;
    }
  } else if ( a.name ) {
    return -1;
  } else if ( b.name ) {
    return 1;
  }
  return a.id - b.id;
}

// A lineage that is a prefix of another (e.g. an observation identified only to genus, and one
// of a species in it) comes first, the way a genus heads its species in a checklist
export function compareLineages( a: LineageStep[], b: LineageStep[] ): number {
  const length = Math.min( a.length, b.length );
  for ( let i = 0; i < length; i += 1 ) {
    if ( a[i].id !== b[i].id ) return compareSteps( a[i], b[i] );
  }
  return a.length - b.length;
}

// Stable, so items of the same taxon keep their incoming order. Items without a lineage go last
export const sortByTaxonomyWithKey = <T>(
  items: T[],
  lineages: Map<string, LineageStep[]>,
  keyOf: ( item: T ) => string,
): T[] => items
    .map( item => ( { item, lineage: lineages.get( keyOf( item ) ) } ) )
    .sort( ( a, b ) => {
      if ( !a.lineage || !b.lineage ) {
        return Number( !a.lineage ) - Number( !b.lineage );
      }
      return compareLineages( a.lineage, b.lineage );
    } )
    .map( ( { item } ) => item );

// Observations, keyed by uuid
export const sortByTaxonomy = <T extends { uuid: string }>(
  items: T[],
  lineages: Map<string, LineageStep[]>,
): T[] => sortByTaxonomyWithKey( items, lineages, item => item.uuid );

// Explore can't download a whole search to sort it, so taxonomic order there covers only this
// many of the most recently added observations, or of the most observed species. Change the
// Taxonomic-order-covers-... strings along with these
export const EXPLORE_TAXONOMIC_OBSERVATIONS_LIMIT = 1000;
export const EXPLORE_TAXONOMIC_SPECIES_LIMIT = 2000;
