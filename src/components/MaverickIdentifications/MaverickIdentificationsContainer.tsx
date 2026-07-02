import { useNavigation, useRoute } from "@react-navigation/native";
import { searchIdentifications } from "api/identifications";
import type { ApiIdentification, ApiTaxon } from "api/types";
import {
  ActivityIndicator,
  Body1,
  Body4,
  DateDisplay,
  DisplayTaxon,
  Divider,
} from "components/SharedComponents";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import { ScreenShell } from "components/SharedComponents/ViewWrapper";
import { View } from "components/styledComponents";
import type { TabStackScreenProps } from "navigation/types";
import React, { useEffect } from "react";
import Taxon from "realmModels/Taxon";
import { useAuthenticatedQuery, useCurrentUser, useTranslation } from "sharedHooks";

// Max page size the API allows
const PAGE_SIZE = 200;

interface MaverickIdentification extends ApiIdentification {
  id: number;
  uuid: string;
  taxon: ApiTaxon;
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

  return identifications;
}

interface MaverickIdentificationItemProps {
  item: MaverickIdentification;
}

const MaverickIdentificationItem = ( { item }: MaverickIdentificationItemProps ) => {
  const navigation = useNavigation( );
  const route = useRoute( );
  const obsUuid = item.observation?.uuid;

  return (
    <View>
      <View className="mx-[15px] my-[11px]">
        <DisplayTaxon
          taxon={item.taxon}
          testID={`MaverickIdentificationItem.${item.uuid}`}
          handlePress={( ) => obsUuid && navigation.navigate( {
            key: `${route.key}-MaverickIdentificationItem-ObsDetails-${item.uuid}`,
            name: "ObsDetails",
            params: { id: obsUuid },
          } )}
          bottomTextComponent={( ) => (
            <Body4>
              {item.created_at && (
                <DateDisplay asDifference dateString={item.created_at} hideIcon />
              )}
            </Body4>
          )}
        />
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
