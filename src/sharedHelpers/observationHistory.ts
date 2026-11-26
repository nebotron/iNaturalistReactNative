import { LIMITED_TAXON_FIELDS } from "api/fields";
import type { ApiTaxon } from "api/types";
import Taxon from "realmModels/Taxon";

// An identification below species level is still an observation of the
// species: the Rock Pigeons people photograph on the street are usually
// identified as the domestic variety (Columba livia domestica, rank_level 5),
// and those are observations of Columba livia. Keying anything off the
// identified taxon alone counts a species as never seen until it happens to be
// identified at exactly species level, so a common bird can turn up as a lifer
// years after the fact.
//
// ancestor_ids runs root to leaf and ends with the taxon's own id, so the entry
// before it is the parent. Every rank below species on iNaturalist hangs
// directly off its species, so the parent is the species.
export const speciesIdFromTaxon = (
  taxon: ApiTaxon | null | undefined,
): number | null => {
  const rankLevel = taxon?.rank_level;
  if ( !taxon?.id || typeof rankLevel !== "number" ) return null;
  // A genus hybrid (Anas × Cairina) is ranked at genus level, but like any
  // other hybrid it's one kind of organism, so it counts as its own species.
  if ( taxon.rank === "genushybrid" ) return taxon.id;
  if ( rankLevel > Taxon.SPECIES_LEVEL ) return null;
  if ( rankLevel === Taxon.SPECIES_LEVEL ) return taxon.id;
  const ancestorIds = ( taxon.ancestor_ids ?? [] ).filter( id => id !== taxon.id );
  return ancestorIds[ancestorIds.length - 1] ?? null;
};

// Fields fetched when paging through the signed-in user's whole observation
// history (the Explore life list and My Lifers share one request shape).
export const OBSERVATION_SYNC_FIELDS = {
  id: true,
  uuid: true,
  observed_on: true,
  time_observed_at: true,
  created_at: true,
  quality_grade: true,
  votes: {
    id: true,
    user_id: true,
    vote_flag: true,
    vote_scope: true,
  },
  observation_photos: {
    photo: {
      url: true,
      license_code: true,
      attribution: true,
    },
  },
  taxon: LIMITED_TAXON_FIELDS,
};
