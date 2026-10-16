import { useNavigation, useRoute } from "@react-navigation/native";
import { searchIdentifications } from "api/identifications";
import type { ApiIdentification, ApiObservation } from "api/types";
import type {
  ExploreV2BaseQueryParams,
} from "components/Explore/ExploreV2/helpers/buildQueryParams";
import identificationOutcome
  from "components/Explore/ExploreV2/helpers/identificationOutcome";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { soundUriFromObservation } from "components/ObservationsFlashList/util";
import {
  ActivityIndicator,
  Body1,
  Body4,
  DateDisplay,
  DisplayTaxonName,
  Divider,
  INatIcon,
  SwitchRow,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { Pressable, View } from "components/styledComponents";
import flatten from "lodash/flatten";
import React, {
  useCallback, useEffect, useMemo, useState,
} from "react";
import type { ListRenderItemInfo } from "react-native";
import Photo from "realmModels/Photo";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import {
  useAuthenticatedInfiniteQuery,
  useCurrentUser,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

const PAGE_SIZE = 20;

interface MyIdentification extends ApiIdentification {
  observation?: {
    uuid?: string;
    identifications?: ApiIdentification[];
    observation_photos?: ApiObservation["observation_photos"];
    observation_sounds?: ApiObservation["observation_sounds"];
  };
}

// /v1/identifications returns a shallow taxon on the identification itself
// (no name), but the same identification nested under the observation carries
// the full taxon, so read the name from there.
const fullTaxon = ( identification: MyIdentification ) => {
  const nested = identification.observation?.identifications
    ?.find( ident => ident.id === identification.id );
  return nested?.taxon?.name
    ? nested.taxon
    : identification.taxon;
};

interface MyIdentificationItemProps {
  item: MyIdentification;
}

const MyIdentificationItem = ( { item }: MyIdentificationItemProps ) => {
  const navigation = useNavigation( );
  const route = useRoute( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );
  const obsUuid = item.observation?.uuid;
  const obsPhoto = item.observation?.observation_photos?.[0]?.photo;
  const photoUri = obsPhoto && Photo.displayLocalOrRemoteMediumPhoto( obsPhoto );
  const taxon = fullTaxon( item );
  const accessibleName = taxon
    ? accessibleTaxonName( taxon, currentUser, t )
    : undefined;
  const { agreed, disagreed } = identificationOutcome(
    item,
    item.observation?.identifications,
  );

  const renderBottomText = useCallback( ( ) => (
    <Body4>
      {item.created_at && (
        <DateDisplay asDifference dateString={item.created_at} hideIcon />
      )}
    </Body4>
  ), [item.created_at] );

  return (
    <View>
      <View className="mx-[15px] my-[11px]">
        <Pressable
          accessibilityRole="button"
          className="flex-row items-center"
          testID={`MyIdentificationItem.${item.uuid}`}
          accessibilityLabel={accessibleName}
          onPress={( ) => obsUuid && navigation.navigate( {
            key: `${route.key}-MyIdentificationItem-ObsDetails-${item.uuid}`,
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
            soundUri={soundUriFromObservation( item.observation )}
            iconicTaxonName={taxon?.iconic_taxon_name}
            testID="MyIdentificationItem.image"
          />
          <View className="ml-3 shrink grow">
            <DisplayTaxonName
              taxon={taxon}
              scientificNameFirst={currentUser?.prefers_scientific_name_first}
              prefersCommonNames={currentUser?.prefers_common_names}
              bottomTextComponent={renderBottomText}
            />
          </View>
          <View className="flex-row items-center ml-2">
            {agreed && (
              <View
                accessible
                accessibilityLabel={t( "Someone-agreed-with-this-identification" )}
              >
                <INatIcon
                  name="checkmark-circle"
                  color={colors.inatGreen}
                  size={22}
                  testID="MyIdentificationItem.agreed"
                />
              </View>
            )}
            {disagreed && (
              <View
                accessible
                accessibilityLabel={t( "Someone-disagreed-with-this-identification" )}
                className="ml-2"
              >
                <INatIcon
                  name="triangle-exclamation"
                  color={colors.warningYellow}
                  size={22}
                  testID="MyIdentificationItem.disagreed"
                />
              </View>
            )}
          </View>
        </Pressable>
      </View>
      <Divider />
    </View>
  );
};

// The identifications search only honors some of Explore's filters. A user
// subject means the identifier here rather than the observer, and nearby or map
// area locations aren't supported, so those are ignored.
const toIdentificationParams = ( params: ExploreV2BaseQueryParams ) => ( {
  user_id: params.user_id,
  taxon_id: params.taxon_id,
  without_taxon_id: params.without_taxon_id,
  place_id: params.place_id,
  project_id: params.project_id,
  quality_grade: params.quality_grade,
} );

interface Props {
  enabled: boolean;
  params: ExploreV2BaseQueryParams;
  onCount: ( count: number ) => void;
}

const ExploreV2IdentificationsView = ( {
  enabled,
  params,
  onCount,
}: Props ) => {
  const { t } = useTranslation( );
  const [mavericksOnly, setMavericksOnly] = useState( false );
  const idParams = useMemo( ( ) => ( {
    ...toIdentificationParams( params ),
    current: true,
    ...( mavericksOnly
      ? { category: "maverick" }
      // Identifications on other people's observations only
      : { own_observation: false } ),
    order_by: "created_at",
    order: "desc",
    per_page: PAGE_SIZE,
  } ), [params, mavericksOnly] );

  const {
    data,
    isLoading,
    fetchNextPage,
  } = useAuthenticatedInfiniteQuery(
    ["exploreV2Identifications", JSON.stringify( idParams )],
    ( { pageParam }: { pageParam?: number }, optsWithAuth: object ) => searchIdentifications(
      { ...idParams, page: pageParam ?? 1 },
      optsWithAuth,
    ),
    {
      enabled,
      initialPageParam: 1,
      getNextPageParam: ( lastPage: { page?: number; total_results?: number } | null ) => (
        lastPage?.page && lastPage.page * PAGE_SIZE < ( lastPage.total_results ?? 0 )
          ? lastPage.page + 1
          : undefined
      ),
    },
  );

  const identifications = useMemo(
    ( ) => flatten(
      data?.pages?.map( ( page: { results?: MyIdentification[] } ) => page?.results ),
    ).filter( Boolean ),
    [data?.pages],
  );

  const totalResults = data?.pages?.[0]?.total_results;
  useEffect( ( ) => {
    if ( typeof totalResults === "number" ) onCount( totalResults );
  }, [totalResults, onCount] );

  const renderItem = useCallback( ( { item }: ListRenderItemInfo<MyIdentification> ) => (
    <MyIdentificationItem item={item} />
  ), [] );

  const toggle = (
    <SwitchRow
      classNames="mx-[15px] my-2"
      label={t( "Maverick-IDs-only" )}
      value={mavericksOnly}
      onValueChange={setMavericksOnly}
      testID="ExploreV2IdentificationsView.mavericksToggle"
    />
  );

  if ( !enabled || isLoading ) {
    return (
      <View>
        {toggle}
        <View className="mt-5 items-center">
          <ActivityIndicator size={50} />
        </View>
      </View>
    );
  }

  return (
    <CustomFlashList
      ListHeaderComponent={toggle}
      data={identifications}
      keyExtractor={( item: MyIdentification ) => `${item.uuid}`}
      renderItem={renderItem}
      onEndReached={( ) => fetchNextPage( )}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={(
        <View className="self-center mt-5 p-4">
          <Body1 className="align-center text-center">
            {t( "No-results-found" )}
          </Body1>
        </View>
      )}
    />
  );
};

export default ExploreV2IdentificationsView;
