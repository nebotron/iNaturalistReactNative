import {
  compareLineages,
  sortByTaxonomy,
  taxonLineageIds,
} from "sharedHelpers/taxonomicSort";

// Ids are deliberately out of alphabetical order, so a sort by id would fail these
const NAMES = new Map( [
  [1, "Life"],
  [2, "Plantae"],
  [3, "Fagaceae"],
  [4, "Quercus"],
  [5, "Quercus sect. Lobatae"],
  [6, "Quercus rubra"],
  [7, "Quercus alba"],
  [8, "Animalia"],
  [9, "Quercus sect. Quercus"],
  [10, "Castanea"],
  [11, "Castanea dentata"],
] );

const lineage = ids => ids.map( id => ( { id, name: NAMES.get( id ) } ) );

const LINEAGES = new Map( [
  ["red-oak", lineage( [1, 2, 3, 4, 5, 6] )],
  ["white-oak", lineage( [1, 2, 3, 4, 9, 7] )],
  ["red-oak-2", lineage( [1, 2, 3, 4, 5, 6] )],
  ["oak-genus", lineage( [1, 2, 3, 4] )],
  ["chestnut", lineage( [1, 2, 3, 10, 11] )],
  ["animal", lineage( [1, 8] )],
] );

const uuids = items => items.map( item => item.uuid );

describe( "taxonomicSort", ( ) => {
  describe( "taxonLineageIds", ( ) => {
    it( "appends the taxon to its ancestors", ( ) => {
      expect( taxonLineageIds( { id: 6, ancestor_ids: [1, 2, 3, 4, 5] } ) )
        .toEqual( [1, 2, 3, 4, 5, 6] );
    } );

    it( "doesn't repeat the taxon when ancestor_ids already include it", ( ) => {
      expect( taxonLineageIds( { id: 4, ancestor_ids: [1, 2, 3, 4] } ) )
        .toEqual( [1, 2, 3, 4] );
    } );

    it( "handles a taxon without ancestors", ( ) => {
      expect( taxonLineageIds( { id: 1, ancestor_ids: null } ) ).toEqual( [1] );
    } );
  } );

  describe( "sortByTaxonomy", ( ) => {
    it( "orders by name at every rank, intermediate ones included", ( ) => {
      const items = [
        "red-oak", "white-oak", "red-oak-2", "oak-genus", "chestnut", "animal",
      ].map( uuid => ( { uuid } ) );
      expect( uuids( sortByTaxonomy( items, LINEAGES ) ) ).toEqual( [
        "animal",
        "chestnut",
        // A genus-level observation heads its genus
        "oak-genus",
        // Section Lobatae before section Quercus, even though Q. alba < Q. rubra
        "red-oak",
        "red-oak-2",
        "white-oak",
      ] );
    } );

    it( "keeps observations of the same taxon in their incoming order", ( ) => {
      const items = [{ uuid: "red-oak-2" }, { uuid: "red-oak" }];
      expect( uuids( sortByTaxonomy( items, LINEAGES ) ) ).toEqual( ["red-oak-2", "red-oak"] );
    } );

    it( "puts observations without a taxon last", ( ) => {
      const items = [{ uuid: "unknown" }, { uuid: "chestnut" }, { uuid: "animal" }];
      expect( uuids( sortByTaxonomy( items, LINEAGES ) ) )
        .toEqual( ["animal", "chestnut", "unknown"] );
    } );
  } );

  describe( "compareLineages", ( ) => {
    it( "keeps taxa with unresolved names together, after their named siblings", ( ) => {
      const unnamed = [{ id: 1 }, { id: 99 }];
      const named = lineage( [1, 8] );
      expect( compareLineages( named, unnamed ) ).toBeLessThan( 0 );
      expect( compareLineages( [...unnamed, { id: 100 }], unnamed ) ).toBeGreaterThan( 0 );
    } );

    it( "ignores case", ( ) => {
      expect( compareLineages(
        [{ id: 1, name: "abies" }],
        [{ id: 2, name: "Picea" }],
      ) ).toBeLessThan( 0 );
    } );
  } );
} );
