import searchMessages from "api/messages";
import classnames from "classnames";
import {
  ActivityIndicator,
  Body2,
  Body3,
  Body4,
  CustomFlashList,
  CustomRefreshControl,
  OfflineNotice,
  UserIcon,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React, { useState } from "react";
import { formatDifferenceForHumans } from "sharedHelpers/dateAndTime";
import { openExternalWebBrowser } from "sharedHelpers/util";
import { useAuthenticatedQuery, useTranslation } from "sharedHooks";

interface Message {
  id: number;
  subject?: string;
  body?: string;
  read_at?: string | null;
  created_at?: string;
  from_user?: { login?: string; icon_url?: string };
}

const ItemSeparator = ( ) => <View className="border-b border-lightGray" />;

const MessagesList = ( ) => {
  const { t, i18n } = useTranslation( );
  const [refreshing, setRefreshing] = useState( false );
  const {
    data, isError, isLoading, refetch,
  } = useAuthenticatedQuery(
    ["searchMessages"],
    optsWithAuth => searchMessages( { box: "inbox", threads: true }, optsWithAuth ),
    { requireLoggedIn: true },
  );
  const messages = ( data || [] ) as Message[];

  const onRefresh = async ( ) => {
    setRefreshing( true );
    await refetch( );
    setRefreshing( false );
  };

  const renderItem = ( { item }: { item: Message } ) => (
    <Pressable
      accessibilityRole="link"
      accessibilityHint={t( "Opens-message-on-iNaturalist-website" )}
      className={classnames(
        "flex-row items-center gap-x-[10px] px-[15px] py-[11px]",
        { "bg-inatGreen/10": !item.read_at },
      )}
      onPress={( ) => openExternalWebBrowser( `https://www.inaturalist.org/messages/${item.id}` )}
    >
      <UserIcon uri={item.from_user?.icon_url} medium />
      <View className="flex-1 gap-y-[4px]">
        <Body3 numberOfLines={1}>{item.from_user?.login}</Body3>
        <Body2 numberOfLines={1}>{item.subject}</Body2>
        <Body4 numberOfLines={2}>{item.body}</Body4>
        {item.created_at && (
          <Body4>{formatDifferenceForHumans( item.created_at, i18n )}</Body4>
        )}
      </View>
    </Pressable>
  );

  const emptyComponent = ( ) => {
    if ( isError ) return <OfflineNotice onPress={refetch} />;
    if ( isLoading ) {
      return (
        <View className="h-full justify-center">
          <ActivityIndicator size={50} />
        </View>
      );
    }
    return <Body2 className="mt-[150px] text-center mx-12">{t( "You-have-no-messages" )}</Body2>;
  };

  return (
    <CustomFlashList
      ItemSeparatorComponent={ItemSeparator}
      ListEmptyComponent={emptyComponent}
      data={messages}
      keyExtractor={( item: Message ) => String( item.id )}
      refreshControl={(
        <CustomRefreshControl
          accessibilityLabel={t( "Pull-to-refresh-notifications" )}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
      renderItem={renderItem}
    />
  );
};

export default MessagesList;
