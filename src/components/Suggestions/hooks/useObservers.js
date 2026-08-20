// @flow

import { fetchObservers } from "api/observations";
import { useAuthenticatedQuery } from "sharedHooks";

const params = {
  per_page: 3,
  fields: {
    user: {
      login: true,
      name: true,
    },
  },
};

// `enabled` is false until the attribution these observers appear in is
// actually on screen. Fetching regardless meant every observation fired this
// twice — once for the offline suggestions and again for the online ones —
// including on the many screens that never show the attribution at all, and in
// the bulk ID flow those requests piled up several deep against the scoring
// request the user was waiting on.
const useObservers = ( taxonIds: number[], enabled: boolean = true ): string[] => {
  const { data } = useAuthenticatedQuery(
    ["fetchObservers", taxonIds],
    ( ) => fetchObservers( {
      ...params,
      taxon_ids: taxonIds,
    } ),
    {
      enabled: !!enabled && !!( taxonIds?.length > 0 ),
    },
  );

  return data?.results?.map( result => result.user.login );
};

export default useObservers;
