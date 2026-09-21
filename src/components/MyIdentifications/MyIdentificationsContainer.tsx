import { useNavigation, useRoute } from "@react-navigation/native";
import { searchIdentifications } from "api/identifications";
import type { ApiIdentification, ApiObservation } from "api/types";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import {
  ActivityIndicator,
  Body1,
  Body4,
  DateDisplay,
  DisplayTaxonName,
  Divider,
  INatIcon,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import flatten from "lodash/flatten";
import type { TabStackScreenProps } from "navigation/types";
import React, { useCallback, useEffect, useMemo } from "react";
import type { ListRenderItemInfo } from "react-native";
import Photo from "realmModels/Photo";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import {
  useAuthenticatedInfiniteQuery,
  useCurrentUser,
  useTranslation,
} from "sharedHooks";
import colors from "styles/tailwindColors";

import identificationOutcome from "./identificationOutcome";

const PAGE_SIZE = 20;

interface MyIdentification extends ApiIdentification {
  observation?: {
    uuid?: string;
    identifications?: ApiIdentification[];
    observation_photos?: ApiObservation["observation_photos"];
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

const MyIdentificationsContainer = ( ) => {
  const navigation = useNavigation<
    TabStackScreenProps<"MyIdentifications">["navigation"]
  >( );
  const currentUser = useCurrentUser( );
  const { t } = useTranslation( );

  const {
    data,
    isLoading,
    fetchNextPage,
  } = useAuthenticatedInfiniteQuery(
    ["fetchMyIdentifications", currentUser?.id],
    ( { pageParam }: { pageParam?: number }, optsWithAuth: object ) => searchIdentifications(
      {
        user_id: currentUser?.id,
        // Identifications on other people's observations only
        own_observation: false,
        current: true,
        order_by: "created_at",
        order: "desc",
        per_page: PAGE_SIZE,
        page: pageParam ?? 1,
      },
      optsWithAuth,
    ),
    {
      enabled: !!currentUser,
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

  useEffect( ( ) => {
    navigation.setOptions( { headerTitle: t( "MY-IDS" ) } );
  }, [navigation, t] );

  const renderItem = useCallback( ( { item }: ListRenderItemInfo<MyIdentification> ) => (
    <MyIdentificationItem item={item} />
  ), [] );

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
        data={identifications}
        keyExtractor={( item: MyIdentification ) => `${item.uuid}`}
        renderItem={renderItem}
        onEndReached={( ) => fetchNextPage( )}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={(
          <View className="self-center mt-5 p-4">
            <Body1 className="align-center text-center">
              {t( "You-havent-identified-any-observations-yet" )}
            </Body1>
          </View>
        )}
      />
    </ScreenShell>
  );
};

export default MyIdentificationsContainer;
