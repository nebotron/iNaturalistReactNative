// Sorting observations into taxonomic order: the same species together, species grouped by
// genus, genera by subfamily, family and so on up, with every intermediate rank (complex,
// section, tribe, ...) taken into account. Equivalent to sorting by each observation's full
// lineage of scientific names, compared one rank at a time.

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

// Stable, so observations of the same taxon keep their incoming order. Observations without a
// taxon go last
export const sortByTaxonomy = <T extends { uuid: string }>(
  items: T[],
  lineages: Map<string, LineageStep[]>,
): T[] => items
    .map( item => ( { item, lineage: lineages.get( item.uuid ) } ) )
    .sort( ( a, b ) => {
      if ( !a.lineage || !b.lineage ) {
        return Number( !a.lineage ) - Number( !b.lineage );
      }
      return compareLineages( a.lineage, b.lineage );
    } )
    .map( ( { item } ) => item );
