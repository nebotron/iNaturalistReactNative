import { readFile } from "@dr.pogodin/react-native-fs";
import { Platform } from "react-native";

import { taxonomyPath } from "./mlModel";

// Maps numeric rank levels (as used in taxonomy file and Realm) to rank name strings
const RANK_LEVEL_TO_RANK: Record<number, string> = {
  100: "stateofmatter",
  70: "kingdom",
  60: "phylum",
  57: "subphylum",
  53: "superclass",
  50: "class",
  47: "subclass",
  45: "infraclass",
  44: "subterclass",
  43: "superorder",
  40: "order",
  37: "suborder",
  35: "infraorder",
  34: "zoosection",
  33: "superfamily",
  32: "epifamily",
  30: "family",
  27: "subfamily",
  26: "supertribe",
  25: "tribe",
  24: "subtribe",
  20: "genus",
  15: "subgenus",
  13: "section",
  12: "subsection",
  11: "complex",
  10: "species",
  5: "subspecies",
};

export interface OfflineTaxonEntry {
  id: number;
  name: string;
  rank_level: number;
  rank: string;
}

let taxonomyCache: Map<number, OfflineTaxonEntry> | null = null;
let loadingPromise: Promise<Map<number, OfflineTaxonEntry>> | null = null;

async function buildTaxonomyCache(): Promise<Map<number, OfflineTaxonEntry>> {
  const content = await readFile( taxonomyPath, "utf8" );
  const map = new Map<number, OfflineTaxonEntry>();

  if ( Platform.OS === "ios" ) {
    const data: Array<{
      taxon_id: number;
      rank_level: number;
      name: string;
    }> = JSON.parse( content );
    for ( const item of data ) {
      map.set( item.taxon_id, {
        id: item.taxon_id,
        name: item.name,
        rank_level: item.rank_level,
        rank: RANK_LEVEL_TO_RANK[item.rank_level] ?? "stateofmatter",
      } );
    }
  } else {
    // CSV: parent_taxon_id,taxon_id,rank_level,leaf_class_id,iconic_class_id,
    //        spatial_class_id,spatial_threshold,name
    const lines = content.split( "\n" );
    for ( let i = 1; i < lines.length; i++ ) {
      const line = lines[i].trim();
      if ( !line ) continue;
      const parts = line.split( "," );
      if ( parts.length < 8 ) continue;
      const taxonId = Number( parts[1] );
      const rankLevel = Number( parts[2] );
      const name = parts[7];
      if ( !taxonId || !name ) continue;
      map.set( taxonId, {
        id: taxonId,
        name,
        rank_level: rankLevel,
        rank: RANK_LEVEL_TO_RANK[rankLevel] ?? "stateofmatter",
      } );
    }
  }

  return map;
}

async function loadTaxonomyCache(): Promise<Map<number, OfflineTaxonEntry>> {
  if ( taxonomyCache ) return taxonomyCache;
  if ( !loadingPromise ) {
    loadingPromise = buildTaxonomyCache().then( cache => {
      taxonomyCache = cache;
      loadingPromise = null;
      return cache;
    } );
  }
  return loadingPromise;
}

/**
 * Resolves ancestor IDs to taxon objects using the bundled taxonomy file.
 * ancestorIds should be in root-to-tip order (as stored from the iNaturalist API).
 */
export async function getAncestorsFromTaxonomyFile(
  ancestorIds: number[],
): Promise<OfflineTaxonEntry[]> {
  const cache = await loadTaxonomyCache();
  return ancestorIds
    .map( id => cache.get( id ) )
    .filter( ( entry ): entry is OfflineTaxonEntry => entry !== undefined );
}
