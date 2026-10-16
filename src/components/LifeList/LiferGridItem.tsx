import { useNavigation, useRoute } from "@react-navigation/native";
import { fetchRemoteObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { Body4, DisplayTaxonName } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import Photo from "realmModels/Photo";
import { withRequestTimeout } from "sharedHelpers/logging";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import {
  OBSERVATION_SYNC_FIELDS,
  speciesIdFromTaxon,
} from "sharedHelpers/userObservationsCache";
import { useCurrentUser, useTranslation } from "sharedHooks";

// Max number of observations the API will fetch by uuid in one request.
const FETCH_BY_UUID_BATCH = 100;

export interface Lifer {
  observed_on: string | null;
  uuid: string;
  observation_photos: ApiObservation["observation_photos"];
  // The taxon the observation was identified as, which is what the grid shows.
  taxon: ApiTaxon;
  // The species it records, which is the taxon itself unless the
  // identification went below species level. What makes it a lifer.
  speciesId: number | null;
}

export const toLifer = ( obs: ApiObservation ): Lifer | null => (
  obs.taxon?.id
    ? {
      observed_on: obs.observed_on ?? null,
      uuid: obs.uuid,
      observation_photos: obs.observation_photos,
      taxon: obs.taxon,
      speciesId: speciesIdFromTaxon( obs.taxon ),
    }
    : null
);

// Fills in the taxon and photo for lifers we have no display data for. After a
// first sync every lifer was seen during the pass, so this does nothing; it
// only fires when a species' lifer changes to an older observation that wasn't
// in the pass (e.g. the previous one lost research grade).
export async function fetchMissingDisplayData(
  uuids: string[],
  display: Record<string, Lifer>,
  opts: { api_token: string | null },
): Promise<void> {
  for ( let i = 0; i < uuids.length; i += FETCH_BY_UUID_BATCH ) {
    const batch = uuids.slice( i, i + FETCH_BY_UUID_BATCH );
    // Its own timeout per batch, for the same reason the observation sync
    // takes one: the caller's signal covers a single request, not a loop.
    // eslint-disable-next-line no-await-in-loop
    const results = await withRequestTimeout( opts, requestOpts => fetchRemoteObservations(
      batch,
      { fields: OBSERVATION_SYNC_FIELDS },
      requestOpts,
    ) );
    ( results ?? [] ).forEach( ( obs: ApiObservation ) => {
      const lifer = toLifer( obs );
      if ( lifer ) {
        display[obs.uuid] = lifer;
      }
    } );
  }
}

interface LiferGridItemProps {
  item: Lifer;
  style?: object;
}

export const LiferGridItem = ( { item, style }: LiferGridItemProps ) => {
  const navigation = useNavigation( );
  const { t } = useTranslation( );
  const currentUser = useCurrentUser( );
  const route = useRoute( );
  const accessibleName = accessibleTaxonName( item.taxon, currentUser, t );

  // Get the photo from the first observation
  const firstObsPhoto = item.observation_photos?.[0]?.photo;
  const source = {
    uri: Photo.displayLocalOrRemoteMediumPhoto(
      firstObsPhoto,
    ),
  };

  const obsPhotosCount = firstObsPhoto
    ? 1
    : 0;

  return (
    <Pressable
      accessibilityRole="button"
      testID={`LiferGridItem.Pressable.${item.uuid}`}
      onPress={( ) => (
        navigation.navigate( {
          key: `${route.key}-LiferGridItem-ObsDetails-${item.uuid}`,
          name: "ObsDetails",
          params: { uuid: item.uuid },
        } )
      )}
      accessibilityLabel={accessibleName}
    >
      <ObsImagePreview
        source={source}
        style={style}
        isMultiplePhotosTop
        obsPhotosCount={obsPhotosCount}
        testID={`LiferGridItem.${item.uuid}`}
        iconicTaxonName={item.taxon.iconic_taxon_name}
      >
        <View className="absolute bottom-0 flex p-2 w-full">
          { item.observed_on && (
            <Body4
              maxFontSizeMultiplier={1.5}
              className="text-white py-1"
            >
              {item.observed_on}
            </Body4>
          ) }
          <DisplayTaxonName
            keyBase={`LiferGridItem-DisplayTaxonName-${item.taxon?.id}`}
            taxon={item.taxon}
            prefersCommonNames={currentUser?.prefers_common_names}
            layout="vertical"
            color="text-white"
            showOneNameOnly
          />
        </View>
      </ObsImagePreview>
    </Pressable>
  );
};
