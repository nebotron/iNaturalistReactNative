import fetchExemplarIdentifications from "api/exemplarIdentifications";
import {
  Body2,
  Heading4,
  INatIcon,
} from "components/SharedComponents";
import { FasterImageView, View } from "components/styledComponents";
import React from "react";
import Photo from "realmModels/Photo";
import { useAuthenticatedQuery, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

const FIELDS = {
  identification: {
    body: true,
    observation: {
      id: true,
      photos: {
        url: true,
      },
    },
  },
  cached_votes_total: true,
};

interface ExemplarIdentification {
  id: number;
  cached_votes_total: number;
  identification: {
    body: string;
    observation: {
      id: number;
      photos: { url: string }[];
    };
  };
}

interface Props {
  taxon: {
    id: number;
    rank_level?: number;
  };
}

const IdentificationTips = ( { taxon }: Props ) => {
  const { t } = useTranslation( );

  const { data } = useAuthenticatedQuery(
    ["fetchExemplarIdentifications", taxon.id],
    optsWithAuth => fetchExemplarIdentifications(
      {
        direct_taxon_id: taxon.id,
        order_by: "votes",
        per_page: 10,
        fields: FIELDS,
      },
      optsWithAuth,
    ),
    {
      allowAnonymousJWT: true,
      enabled: !!taxon.id,
    },
  );

  const tips: ExemplarIdentification[] = data?.results ?? [];

  if ( tips.length === 0 ) return null;

  return (
    <View className="mb-6">
      <Heading4 className="mb-3">{t( "IDENTIFICATION-TIPS" )}</Heading4>
      {tips.map( tip => {
        const photoUrl = tip.identification?.observation?.photos?.[0]?.url;
        const squareUrl = photoUrl
          ? Photo.displayMediumPhoto( photoUrl )
          : undefined;
        const body = tip.identification?.body;

        return (
          <View
            key={tip.id}
            className="flex-row mb-4"
          >
            {squareUrl && (
              <FasterImageView
                className="w-[62px] h-[62px] rounded-lg mr-3 shrink-0"
                source={{ uri: squareUrl }}
                resizeMode="cover"
              />
            )}
            <View className="flex-1">
              {body ? (
                <Body2 className="text-darkGray">{body}</Body2>
              ) : null}
              {tip.cached_votes_total > 0 && (
                <View className="flex-row items-center mt-1">
                  <INatIcon name="heart" size={12} color={colors.darkGray} />
                  <Body2 className="ml-1 text-darkGray">
                    {tip.cached_votes_total}
                  </Body2>
                </View>
              )}
            </View>
          </View>
        );
      } )}
    </View>
  );
};

export default IdentificationTips;
