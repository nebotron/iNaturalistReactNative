import type {
  ApiProjectSummary,
  ApiTaxon,
  ApiUser,
} from "api/types";
import type { ExploreV2Subject } from "providers/ExploreV2Context";

export type UniversalSearchResultItem =
  | { type: "taxon"; taxon: ApiTaxon }
  | { type: "user"; user: ApiUser }
  | { type: "project"; project: ApiProjectSummary };

// Maps a taxon, user, or project to the ExploreV2 context's subject shape

export const resultToSubject = ( result: UniversalSearchResultItem ): ExploreV2Subject => {
  switch ( result.type ) {
    case "user":
      return {
        type: "user",
        user: {
          id: result.user.id,
          login: result.user.login,
          icon_url: result.user.icon_url,
          observations_count: result.user.observations_count,
        },
      };
    case "project":
      return {
        type: "project",
        project: result.project,
      };
    case "taxon":
      return {
        type: "taxon",
        taxon: {
          id: result.taxon.id,
          name: result.taxon.name,
          preferred_common_name: result.taxon.preferred_common_name,
          default_photo: result.taxon.default_photo?.url
            ? { url: result.taxon.default_photo.url }
            : undefined,
          iconic_taxon_name: result.taxon.iconic_taxon_name,
          rank_level: result.taxon.rank_level,
        },
      };
    default:
      throw new Error( `resultToSubject: Unknown explore 
        subject result type: ${( result as { type: string } ).type}` );
  }
};
