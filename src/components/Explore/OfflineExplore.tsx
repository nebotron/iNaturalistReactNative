import ObservationsFlashList from "components/ObservationsFlashList/ObservationsFlashList";
import {
  ActivityIndicator,
  Body3,
  INatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useEffect, useMemo, useState, useSyncExternalStore,
} from "react";
import { Alert } from "react-native";
import {
  deleteOfflineExploreResults,
  downloadOfflineExploreResults,
  filterOfflineObservations,
  getCachedOfflineExploreResults,
  loadOfflineExploreResults,
  MAX_OFFLINE_OBSERVATIONS,
  subscribeOfflineExploreResults,
} from "sharedHelpers/offlineExploreResults";
import { useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

const DROP_SHADOW = getShadow( { offsetHeight: 4, elevation: 6 } );
const ROUND = { borderRadius: 22 };
const OBS_LIST_CONTAINER_STYLE = { paddingTop: 50 };
const noop = ( ) => undefined;

export const useOfflineExploreResults = ( ) => {
  useEffect( ( ) => { loadOfflineExploreResults( ); }, [] );
  return useSyncExternalStore(
    subscribeOfflineExploreResults,
    getCachedOfflineExploreResults,
  );
};

interface SaveProps {
  queryParams: Record<string, unknown>;
}

// Saves the current search's results so they can be browsed and filtered
// further with no connection
export const SaveOfflineButton = ( { queryParams }: SaveProps ) => {
  const { t } = useTranslation( );
  const [progress, setProgress] = useState<number | null>( null );

  const save = async ( ) => {
    setProgress( 0 );
    try {
      const { observations } = await downloadOfflineExploreResults( queryParams, setProgress );
      Alert.alert( t( "Saved-for-offline-use", { count: observations.length } ) );
    } catch {
      Alert.alert( t( "Something-went-wrong" ) );
    } finally {
      setProgress( null );
    }
  };

  const onPress = ( ) => Alert.alert(
    t( "Save-for-offline-use" ),
    t( "Save-up-to-observations-from-this-search", { count: MAX_OFFLINE_OBSERVATIONS } ),
    [
      { text: t( "Cancel" ), style: "cancel" },
      { text: t( "SAVE" ), onPress: save },
    ],
  );

  return (
    <View className="absolute bottom-5 right-5 z-10 flex-row items-center">
      {progress !== null && (
        <View className="bg-white rounded-full px-3 py-2 mr-2 flex-row" style={DROP_SHADOW}>
          <ActivityIndicator size={16} />
          <Body3 className="ml-2">{progress}</Body3>
        </View>
      )}
      <INatIconButton
        icon="arrow-down-bold-circle-outline"
        color={colors.darkGray}
        backgroundColor={colors.white}
        disabled={progress !== null}
        onPress={onPress}
        size={20}
        width={44}
        style={[DROP_SHADOW, ROUND]}
        accessibilityLabel={t( "Save-for-offline-use" )}
      />
    </View>
  );
};

interface ViewProps {
  layout: string | null;
  queryParams: Record<string, unknown>;
}

// Shows saved results, filtered on device by the current Explore filters
export const OfflineObservationsView = ( { layout, queryParams }: ViewProps ) => {
  const { t } = useTranslation( );
  const saved = useOfflineExploreResults( );
  const observations = useMemo(
    ( ) => filterOfflineObservations( saved?.observations || [], queryParams ),
    [saved, queryParams],
  );
  if ( !saved ) return null;
  const listLayout = layout === "list"
    ? "list"
    : "grid";
  const onPressDelete = ( ) => Alert.alert( t( "Delete-offline-results" ), undefined, [
    { text: t( "Cancel" ), style: "cancel" },
    { text: t( "DELETE" ), style: "destructive", onPress: deleteOfflineExploreResults },
  ] );

  return (
    <View className="flex-1">
      <ObservationsFlashList
        contentContainerStyle={OBS_LIST_CONTAINER_STYLE}
        data={observations}
        explore
        handlePullToRefresh={noop}
        handleIndividualUploadPress={noop}
        hideLoadingWheel
        isConnected={false}
        layout={listLayout}
        obsListKey="OfflineExploreObservations"
        onEndReached={noop}
        showNoResults={observations.length === 0}
        hideObsUploadStatus={listLayout === "grid"}
        fullWidthGrid={listLayout === "grid"}
        testID="OfflineExploreObservations"
      />
      <View
        className="absolute bottom-5 right-5 z-10 bg-white rounded-full px-3 py-2"
        style={DROP_SHADOW}
      >
        <Body3 onPress={onPressDelete}>
          {t( "Offline-X-of-Y-saved-observations", {
            count: observations.length,
            total: saved.observations.length,
          } )}
        </Body3>
      </View>
    </View>
  );
};
