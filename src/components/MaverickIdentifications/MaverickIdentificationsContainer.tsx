import { useNavigation, useRoute } from "@react-navigation/native";
import { searchIdentifications } from "api/identifications";
import { fetchTaxon } from "api/taxa";
import type { ApiIdentification, ApiObservation, ApiTaxon } from "api/types";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import {
  ActivityIndicator,
  Body1,
  Body4,
  DateDisplay,
  DisplayTaxonName,
  Divider,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useEffect } from "react";
import Photo from "realmModels/Photo";
import Taxon from "realmModels/Taxon";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import { useAuthenticatedQuery, useCurrentUser, useTranslation } from "sharedHooks";

// Max page size the API allows
const PAGE_SIZE = 200;

// Max number of taxon ids the /v1/taxa batch endpoint accepts per request
const TAXA_BATCH_SIZE = 30;

interface MaverickIdentification extends ApiIdentification {
  id: number;
  uuid: string;
  taxon: ApiTaxon;
  observation?: {
    uuid?: string;
    observation_photos?: ApiObservation["observation_photos"];
  };
}

// The /v1/identifications endpoint returns a shallow taxon (id/rank only,
// no name), so the species name never renders. Backfill the missing names by
// batch-fetching the full taxa and merging them onto each identification.
async function enrichTaxonNames(
  identifications: MaverickIdentification[],
  opts: { api_token: string | null },
): Promise<void> {
  const taxonIds = [...new Set(
    identifications
      .filter( identification => identification.taxon && !identification.taxon.name )
      .map( identification => identification.taxon.id )
      .filter( ( id ): id is number => Boolean( id ) ),
  )];
  if ( taxonIds.length === 0 ) return;

  const batches: number[][] = [];
  for ( let i = 0; i < taxonIds.length; i += TAXA_BATCH_SIZE ) {
    batches.push( taxonIds.slice( i, i + TAXA_BATCH_SIZE ) );
  }
  const responses = await Promise.all(
    batches.map( batch => fetchTaxon( batch, {}, opts ) ),
  );

  const taxaById = new Map<number, ApiTaxon>( );
  responses.forEach( response => {
    const results = ( response as { results?: ApiTaxon[] } | null )?.results ?? [];
    results.forEach( taxon => {
      if ( taxon.id ) taxaById.set( taxon.id, taxon );
    } );
  } );

  identifications.forEach( identification => {
    const taxonId = identification.taxon?.id;
    const fullTaxon = taxonId
      ? taxaById.get( taxonId )
      : undefined;
    if ( fullTaxon ) {
      identification.taxon = { ...identification.taxon, ...fullTaxon };
    }
  } );
}

async function fetchMaverickIdentifications(
  userId: number | undefined,
  opts: { api_token: string | null },
): Promise<MaverickIdentification[]> {
  if ( !userId ) return [];

  const identifications: MaverickIdentification[] = [];
  let page = 1;
  let hasMorePages = true;
  while ( hasMorePages ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchIdentifications(
      {
        user_id: userId,
        category: "maverick",
        order_by: "created_at",
        order: "desc",
        per_page: PAGE_SIZE,
        page,
        fields: {
          id: true,
          uuid: true,
          created_at: true,
          taxon: Taxon.LIMITED_TAXON_FIELDS,
          observation: {
            uuid: true,
            observation_photos: {
              photo: {
                url: true,
              },
            },
          },
        },
      },
      opts,
    ) as { results?: MaverickIdentification[] } | null;
    const results = response?.results ?? [];
    identifications.push( ...results );
    hasMorePages = results.length === PAGE_SIZE;
    page += 1;
  }

  await enrichTaxonNames( identifications, opts );

  return identifications;
}

interface MaverickIdentificationItemProps {
  item: MaverickIdentification;
}

const MaverickIdentificationItem = ( { item }: MaverickIdentificationItemProps ) => {
  const navigation = useNavigation( );
  const route = useRoute( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );
  const obsUuid = item.observation?.uuid;
  const obsPhoto = item.observation?.observation_photos?.[0]?.photo;
  const photoUri = obsPhoto && Photo.displayLocalOrRemoteMediumPhoto( obsPhoto );
  const accessibleName = item.taxon
    ? accessibleTaxonName( item.taxon, currentUser, t )
    : undefined;

  return (
    <View>
      <View className="mx-[15px] my-[11px]">
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center shrink"
          testID={`MaverickIdentificationItem.${item.uuid}`}
          accessibilityLabel={accessibleName}
          onPress={( ) => obsUuid && navigation.navigate( {
            key: `${route.key}-MaverickIdentificationItem-ObsDetails-${item.uuid}`,
            name: "ObsDetails",
            params: { uuid: obsUuid },
          } )}
        >
          <ObsImagePreview
            source={photoUri
              ? { uri: photoUri }
              : undefined}
            autoDetectSubject={!!photoUri}
            isSmall
            hidePhotoCount
            iconicTaxonName={item.taxon?.iconic_taxon_name}
            testID="MaverickIdentificationItem.image"
          />
          <View className="ml-3 shrink">
            <DisplayTaxonName
              taxon={item.taxon}
              scientificNameFirst={currentUser?.prefers_scientific_name_first}
              prefersCommonNames={currentUser?.prefers_common_names}
              bottomTextComponent={( ) => (
                <Body4>
                  {item.created_at && (
                    <DateDisplay asDifference dateString={item.created_at} hideIcon />
                  )}
                </Body4>
              )}
            />
          </View>
        </Pressable>
      </View>
      <Divider />
    </View>
  );
};

const MaverickIdentificationsContainer = ( ) => {
  const navigation = useNavigation<
    TabStackScreenProps<"MaverickIdentifications">["navigation"]
  >( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );

  const { data: identifications, isLoading } = useAuthenticatedQuery(
    ["fetchMaverickIdentifications", currentUser?.id],
    optsWithAuth => fetchMaverickIdentifications( currentUser?.id, optsWithAuth ),
    { enabled: !!currentUser },
  );

  useEffect( ( ) => {
    navigation.setOptions( { headerTitle: t( "MY-MAVERICK-IDS" ) } );
  }, [navigation, t] );

  if ( isLoading ) {
    return (
      <ScreenShell>
        <ActivityIndicator size={50} />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      <View className="border-b border-lightGray mt-5" />
      <CustomFlashList
        data={identifications ?? []}
        keyExtractor={( item: MaverickIdentification ) => `${item.uuid}`}
        renderItem={( { item }: { item: MaverickIdentification } ) => (
          <MaverickIdentificationItem item={item} />
        )}
        ListEmptyComponent={(
          <View className="self-center mt-5 p-4">
            <Body1 className="align-center text-center">
              {t( "You-dont-have-any-maverick-identifications" )}
            </Body1>
          </View>
        )}
      />
    </ScreenShell>
  );
};

export default MaverickIdentificationsContainer;
