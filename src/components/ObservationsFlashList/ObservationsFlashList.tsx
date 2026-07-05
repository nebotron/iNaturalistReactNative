/* eslint-disable react/no-unused-prop-types */
import { prefetch } from "@candlefinance/faster-image";
import { useNavigation } from "@react-navigation/native";
import type { FlashListRef, ViewToken } from "@shopify/flash-list";
import {
  ActivityIndicator,
  Body3,
  CustomFlashList,
  CustomRefreshControl,
  InfiniteScrollLoadingWheel,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, StyleProp, ViewStyle,
} from "react-native";
import { Animated } from "react-native";
import RealmObservation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import {
  useCurrentUser,
  useGridLayout,
  useLayoutPrefs,
  useNavigateToObsEdit,
  useTranslation,
} from "sharedHooks";
import useStore from "stores/useStore";

import ObsPressable from "./ObsPressable";
import { photoFromObservation, photosFromObservation } from "./util";

const { useRealm } = RealmContext;

const AnimatedFlashList = Animated.createAnimatedComponent( CustomFlashList );

// unlike the other FlashList Component props, Separator does _not_ accept an Element
const ItemSeparator = () => <View className="border-b border-lightGray" />;

interface Props {
  contentContainerStyle?: StyleProp<ViewStyle>;
  data: ( { uuid: string } )[];
  dataCanBeFetched?: boolean;
  fetchFromLastObservation?: ( observationId?: number ) => void;
  explore: boolean;
  handlePullToRefresh: () => void;
  handleIndividualUploadPress: ( observationUuid: string ) => void;
  hideLoadingWheel?: boolean;
  hideMetadata?: boolean;
  hideObsUploadStatus?: boolean;
  hideObsStatus?: boolean;
  isSimpleObsStatus?: boolean;
  hideRGLabel?: boolean;
  isConnected: boolean;
  layout: "list" | "grid";
  obsListKey: string;
  onEndReached: () => void;
  onExploreObservationAction?: () => void;
  onLayout?: ( event: LayoutChangeEvent ) => void;
  onScroll?: ( event: NativeSyntheticEvent<NativeScrollEvent> ) => void;
  // this ref is being forwarded to the underlying CustomFlashList and used as an imperative handle
  // so the parent can control behavior like scrolling
  // TODO: type data / observations
  ref?: React.Ref<FlashListRef<( { uuid: string} )>>;
  listHeaderContent?: React.ReactElement | null;
  showNoResults?: boolean;
  showObservationsEmptyScreen?: boolean;
  fullWidthGrid?: boolean;
  testID: string;
}

const ObservationsFlashList = ( {
  contentContainerStyle: contentContainerStyleProp = {},
  data,
  dataCanBeFetched,
  explore,
  fetchFromLastObservation,
  handlePullToRefresh,
  handleIndividualUploadPress,
  hideLoadingWheel,
  hideMetadata,
  hideObsUploadStatus,
  hideObsStatus,
  isSimpleObsStatus,
  hideRGLabel,
  isConnected,
  layout,
  obsListKey = "unknown",
  onEndReached,
  onExploreObservationAction,
  onLayout,
  onScroll,
  ref,
  listHeaderContent,
  showNoResults,
  showObservationsEmptyScreen,
  fullWidthGrid = false,
  testID,
}: Props ) => {
  const {
    isDefaultMode,
  } = useLayoutPrefs( );
  const realm = useRealm( );
  const currentUser = useCurrentUser( );
  const navigation = useNavigation( );
  const navigateToObsEdit = useNavigateToObsEdit( );
  const uploadQueue = useStore( state => state.uploadQueue );
  const totalUploadProgress = useStore( state => state.totalUploadProgress );
  const [refreshing, setRefreshing] = useState( false );

  const onRefresh = async ( ) => {
    setRefreshing( true );
    await handlePullToRefresh( );
    setRefreshing( false );
  };

  const {
    flashListStyle,
    gridItemStyle,
    numColumns,
    squareCorners,
  } = useGridLayout(
    layout === "list"
      ? "list"
      : undefined,
    fullWidthGrid
      ? "fullWidth"
      : "default",
  );
  const { t } = useTranslation( );

  const renderItem = useCallback( ( { item }: { item: { uuid: string; empty: boolean } } ) => {
    // Empty box
    if ( item.empty ) {
      return (
        <View
          className={fullWidthGrid
            ? "border-dotted border-4 border-lightGray"
            : "rounded-[15px] border-dotted border-4 border-lightGray"}
          style={gridItemStyle}
        />
      );
    }
    const { uuid } = item;
    const onUploadButtonPress = ( ) => handleIndividualUploadPress( uuid );
    const obsNeedsSync = RealmObservation.isUnsyncedObservation( realm, item );
    const obsUploadState = totalUploadProgress.find( o => o.uuid === uuid );
    const uploadProgress = obsNeedsSync
      ? obsUploadState?.totalProgress || 0
      : obsUploadState?.totalProgress;

    const queued = uploadQueue.includes( uuid );

    const onItemPress = ( ) => {
      if ( obsNeedsSync && !isDefaultMode ) {
        const realmObservation = realm.objectForPrimaryKey( "Observation", uuid );
        navigateToObsEdit( realmObservation );
      } else {
        // Uniquely identify the list this observation appears in so we can ensure
        // ObsDetails doesn't get pushed onto the stack twice after multiple taps
        navigation.navigate( {
          key: `Obs-${obsListKey}-${uuid}`,
          name: "ObsDetails",
          // Pass explore observation so ObsDetails can render immediately
          // while the full remote fetch completes in the background
          params: {
            uuid,
            preloadedObservation: obsNeedsSync
              ? undefined
              : item,
          },
        } );
      }
    };

    return (
      <ObsPressable
        currentUser={currentUser}
        explore={explore}
        gridItemStyle={gridItemStyle}
        hideMetadata={hideMetadata}
        hideObsUploadStatus={hideObsUploadStatus}
        hideObsStatus={hideObsStatus}
        isSimpleObsStatus={isSimpleObsStatus}
        hideRGLabel={hideRGLabel}
        layout={layout}
        apiObservation={explore
          ? item
          : undefined}
        onExploreObservationAction={onExploreObservationAction}
        uuid={uuid}
        onItemPress={onItemPress}
        onUploadButtonPress={onUploadButtonPress}
        queued={queued}
        unsynced={obsNeedsSync}
        uploadProgress={uploadProgress}
        squareCorners={squareCorners}
      />
    );
  }, [
    currentUser,
    explore,
    gridItemStyle,
    handleIndividualUploadPress,
    hideMetadata,
    hideObsUploadStatus,
    hideObsStatus,
    isSimpleObsStatus,
    hideRGLabel,
    isDefaultMode,
    layout,
    navigateToObsEdit,
    navigation,
    obsListKey,
    onExploreObservationAction,
    realm,
    totalUploadProgress,
    uploadQueue,
    squareCorners,
    fullWidthGrid,
  ] );

  const itemSeparatorComponent = useMemo( ( ) => {
    if ( layout === "grid" ) {
      return null;
    }
    return ItemSeparator;
  }, [layout] );

  const footerContent = useMemo( ( ) => (
    <InfiniteScrollLoadingWheel
      explore={explore}
      hideLoadingWheel={hideLoadingWheel}
      isConnected={isConnected}
      layout={layout}
    />
  ), [
    explore,
    hideLoadingWheel,
    isConnected,
    layout,
  ] );

  const contentContainerStyle = useMemo( ( ) => {
    if ( layout === "list" ) { return contentContainerStyleProp; }
    return {
      ...flashListStyle,
      ...contentContainerStyleProp,
    };
  }, [
    contentContainerStyleProp,
    flashListStyle,
    layout,
  ] );

  const emptyContent = useMemo( ( ) => {
    const showEmptyScreen = showObservationsEmptyScreen
      ? null
      : (
        <Body3 className="self-center mt-[150px]">
          {t( "No-results-found-try-different-search" )}
        </Body3>
      );

    return showNoResults
      ? showEmptyScreen
      : (
        <View className="self-center mt-[150px]">
          <ActivityIndicator size={50} testID="ObservationsFlashList.loading" />
        </View>
      );
  }, [
    showObservationsEmptyScreen,
    showNoResults,
    t,
  ] );

  // only used id as a fallback key because after upload
  // react thinks we've rendered a second item w/ a duplicate key
  const keyExtractor = item => item.uuid || item.id;

  const onMomentumScrollEnd = useCallback( ( ) => {
    if ( dataCanBeFetched ) {
      onEndReached( );
    }
  }, [dataCanBeFetched, onEndReached] );

  // Use a ref so the stable callback below always sees the current data
  const dataRef = useRef<unknown[]>( data );
  useEffect( ( ) => {
    dataRef.current = data;
  }, [data] );

  const handleViewableItemsChanged = useCallback(
    ( { viewableItems }: { viewableItems: ViewToken<unknown>[] } ) => {
      if ( !explore ) return;

      const maxVisibleIndex = viewableItems.reduce(
        ( max, token ) => Math.max( max, token.index ?? -1 ),
        -1,
      );
      if ( maxVisibleIndex < 0 ) return;

      const currentData = dataRef.current;

      // Priority 1: first photo of next 5 items in the vertical scroll
      const nextItemUrls: string[] = [];
      for (
        let i = maxVisibleIndex + 1;
        i <= maxVisibleIndex + 5 && i < currentData.length;
        i += 1
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obs = currentData[i] as any;
        if ( !obs?.empty ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const photo = photoFromObservation( obs );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const url = Photo.displayLocalOrRemoteOriginalPhoto( photo as any );
          if ( url ) nextItemUrls.push( url );
        }
      }

      // Priority 2: carousel photos beyond the first for currently visible items
      const carouselUrls: string[] = [];
      for ( const token of viewableItems ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const obs = token.item as any;
        if ( !obs?.empty ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const photos = photosFromObservation( obs );
          for ( let i = 1; i < photos.length; i += 1 ) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const url = Photo.displayLocalOrRemoteOriginalPhoto( photos[i] as any );
            if ( url ) carouselUrls.push( url );
          }
        }
      }

      const allUrls = [...nextItemUrls, ...carouselUrls];
      if ( allUrls.length > 0 ) {
        prefetch( allUrls );
      }
    },
    [explore],
  );

  const handleEndReached = useCallback( ( ) => {
    if ( !dataCanBeFetched || explore ) return;

    if ( fetchFromLastObservation && data.length > 0 ) {
      const lastItem = data[data.length - 1];
      if ( lastItem?.uuid && !lastItem?.empty ) {
        const lastObs = realm.objectForPrimaryKey( "Observation", lastItem.uuid );
        const lastId = lastObs?.id;
        if ( lastId ) {
          fetchFromLastObservation( lastId );
          return;
        }
      }
    }

    onEndReached( );
  }, [dataCanBeFetched, explore, fetchFromLastObservation, data, onEndReached, realm] );

  const refreshControl = (
    <CustomRefreshControl
      accessibilityLabel={t( "Pull-to-refresh-and-sync-observations" )}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );

  return (
    <AnimatedFlashList
      ItemSeparatorComponent={itemSeparatorComponent}
      ListEmptyComponent={emptyContent}
      ListFooterComponent={footerContent}
      ListHeaderComponent={listHeaderContent}
      contentContainerStyle={contentContainerStyle}
      data={data}
      ref={ref}
      key={numColumns}
      keyExtractor={keyExtractor}
      numColumns={numColumns}
      onLayout={onLayout}
      onEndReached={handleEndReached}
      onMomentumScrollEnd={onMomentumScrollEnd}
      onScroll={onScroll}
      onViewableItemsChanged={handleViewableItemsChanged}
      renderItem={renderItem}
      refreshControl={refreshControl}
      testID={testID}
    />
  );
};

export default ObservationsFlashList;
