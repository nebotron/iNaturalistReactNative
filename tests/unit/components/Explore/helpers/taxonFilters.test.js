import {
  migrateTaxonFilters,
  normalizeTaxonFilters,
  removeTaxonFilter,
  taxonFiltersToApiParams,
  toExploreTaxonFilterTaxon,
  toggleTaxonFilter,
} from "components/Explore/helpers/taxonFilters";

describe( "taxonFilters helpers", () => {
  const homo = { id: 1, name: "Homo" };
  const aves = { id: 3, name: "Aves" };
  const plantae = { id: 47126, name: "Plantae" };

  describe( "toExploreTaxonFilterTaxon", () => {
    it( "stores plain taxon fields from realm-like objects", () => {
      expect( toExploreTaxonFilterTaxon( {
        id: 1,
        name: "Homo",
        preferredCommonName: "Human",
        defaultPhoto: { url: "https://example.com/homo.jpg" },
        iconic_taxon_name: "Mammalia",
      } ) ).toEqual( {
        id: 1,
        name: "Homo",
        preferred_common_name: "Human",
        default_photo: { url: "https://example.com/homo.jpg" },
        iconic_taxon_name: "Mammalia",
      } );
    } );
  } );

  describe( "normalizeTaxonFilters", () => {
    it( "normalizes stored taxon filters", () => {
      expect( normalizeTaxonFilters( [
        {
          exclude: false,
          taxon: {
            id: 1,
            name: "Homo",
            preferredCommonName: "Human",
          },
        },
      ] ) ).toEqual( [
        {
          exclude: false,
          taxon: {
            id: 1,
            name: "Homo",
            preferred_common_name: "Human",
            default_photo: undefined,
          },
        },
      ] );
    } );
  } );

  describe( "migrateTaxonFilters", () => {
    it( "returns existing taxonFilters when present", () => {
      const taxonFilters = [{ taxon: homo, exclude: false }];
      expect( migrateTaxonFilters( { taxonFilters } ) ).toEqual( taxonFilters );
    } );

    it( "migrates a legacy single taxon filter", () => {
      expect( migrateTaxonFilters( { taxon: homo, taxon_id: 1 } ) ).toEqual( [
        { taxon: homo, exclude: false },
      ] );
    } );
  } );

  describe( "taxonFiltersToApiParams", () => {
    it( "maps include and exclude taxa to API params", () => {
      expect( taxonFiltersToApiParams( [
        { taxon: homo, exclude: false },
        { taxon: aves, exclude: false },
        { taxon: plantae, exclude: true },
      ] ) ).toEqual( {
        taxon_id: "1,3",
        without_taxon_id: 47126,
      } );
    } );
  } );

  describe( "toggleTaxonFilter", () => {
    it( "adds, toggles mode, and removes taxa", () => {
      let filters = [];
      filters = toggleTaxonFilter( filters, {
        id: 1,
        name: "Homo",
        preferredCommonName: "Human",
      }, false );
      expect( filters ).toEqual( [{
        taxon: {
          id: 1,
          name: "Homo",
          preferred_common_name: "Human",
          default_photo: undefined,
        },
        exclude: false,
      }] );

      filters = toggleTaxonFilter( filters, {
        id: 1,
        name: "Homo",
        preferredCommonName: "Human",
      }, true );
      expect( filters ).toEqual( [{
        taxon: {
          id: 1,
          name: "Homo",
          preferred_common_name: "Human",
          default_photo: undefined,
          iconic_taxon_name: undefined,
          rank: undefined,
          rank_level: undefined,
        },
        exclude: true,
      }] );

      filters = toggleTaxonFilter( filters, {
        id: 1,
        name: "Homo",
        preferredCommonName: "Human",
      }, true );
      expect( filters ).toEqual( [] );
    } );
  } );

  describe( "removeTaxonFilter", () => {
    it( "removes a taxon by id", () => {
      const filters = [
        { taxon: homo, exclude: false },
        { taxon: aves, exclude: true },
      ];
      expect( removeTaxonFilter( filters, 1 ) ).toEqual( [
        { taxon: aves, exclude: true },
      ] );
    } );
  } );
} );
