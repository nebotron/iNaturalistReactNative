import { fetchRemoteObservation } from "api/observations";
import { InlineUser } from "components/SharedComponents";
import { View } from "components/styledComponents";
import type { ReactNode } from "react";
import React from "react";
import { useAuthenticatedQuery } from "sharedHooks";

interface FaveVote {
  id: number;
  vote_scope: string | null;
  user?: { id: number; login: string; icon_url?: string };
}

interface Props {
  observation: {
    id?: number;
    uuid: string;
    votes?: { vote_scope: string | null }[];
  };
  heading: ReactNode;
  className?: string;
}

const FavoritesList = ( { observation, heading, className }: Props ) => {
  const faveCount = observation?.votes?.filter( v => v?.vote_scope === null ).length || 0;
  const { data: faves } = useAuthenticatedQuery<FaveVote[]>(
    // Fave count in the key refetches after the viewer toggles their own fave
    ["fetchObservationFaves", observation?.uuid, faveCount],
    async optsWithAuth => {
      const remote = await fetchRemoteObservation(
        observation.uuid,
        {
          fields: {
            votes: { id: true, vote_scope: true, user: { id: true, login: true, icon_url: true } },
          },
        },
        optsWithAuth,
      );
      return ( remote?.votes || [] ).filter( ( v: FaveVote ) => v.vote_scope === null && v.user );
    },
    { enabled: !!observation?.id && faveCount > 0 },
  );

  if ( faveCount === 0 || !faves?.length ) return null;

  return (
    <View className={className}>
      {heading}
      <View className="space-y-[11px]">
        {faves.map( fave => fave.user && (
          <InlineUser key={fave.id} user={fave.user} isConnected />
        ) )}
      </View>
    </View>
  );
};

export default FavoritesList;
