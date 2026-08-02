/* eslint-disable i18next/no-literal-string */
import { FlashList } from "@shopify/flash-list";
import DevicePhotoThumbnail from "components/DevicePhotoCleanup/DevicePhotoThumbnail";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import {
  ActivityIndicator,
  Body2,
  BottomSheet,
  Button,
  ButtonBar,
  Heading4,
  List2,
  ViewWrapper,
} from "components/SharedComponents";
import Modal from "components/SharedComponents/Modal";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { log } from "sharedHelpers/logger";
import { deleteOriginalDevicePhotos } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import type { UnfavoritedPhotoDay } from "sharedHelpers/unfavoritedDevicePhotos";
import findUnfavoritedDevicePhotoDays, {
  prefetchDeviceAssets,
} from "sharedHelpers/unfavoritedDevicePhotos";
import type { UserObservationsCache } from "sharedHelpers/userObservationsCache";
import {
  readUserObservationsCache,
  syncUserObservations,
} from "sharedHelpers/userObservationsCache";
import { useCurrentUser } from "sharedHooks";

const logger = log.extend( "DevicePhotoCleanup" );

const { useRealm } = RealmContext;

const THUMB_SIZE = 78;
const THUMB_MARGIN = 3;
// The grid spans the full screen width with no padding or gutters, so a row is
// exactly three square tiles wide.
const GRID_COLUMNS = 3;
// Cap how many thumbnails we render in the confirmation preview strip so a
// huge selection doesn't bog the sheet down; the count still reflects all.
const CONFIRM_PREVIEW_LIMIT = 30;

const styles = StyleSheet.create( {
  fullScreenImage: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100,
  },
  thumb: {
    borderRadius: 4,
    height: THUMB_SIZE,
    margin: THUMB_MARGIN,
    width: THUMB_SIZE,
  },
} );

// One row of the virtualized grid: either a day's header or a row of that day's
// thumbnails. Flattening days into rows lets FlashList mount only the
// thumbnails on screen — rendering an Image per photo up front meant thousands
// of live PHAsset loads before the list could be scrolled.
type GridRow =
  | { type: "header"; key: string; label: string }
  | { type: "photos"; key: string; uris: string[] };

const buildGridRows = (
  days: UnfavoritedPhotoDay[],
  columns: number,
): GridRow[] => days.flatMap( day => {
  const rows: GridRow[] = [
    { type: "header", key: `${day.dateKey}-header`, label: day.label },
  ];
  for ( let i = 0; i < day.uris.length; i += columns ) {
    rows.push( {
      type: "photos",
      key: `${day.dateKey}-${i}`,
      uris: day.uris.slice( i, i + columns ),
    } );
  }
  return rows;
} );

// Brings the shared observation cache up to date, falling back to the last
// synced copy if the network is unavailable. Stale fave data is worse than
// none — it's what makes a freshly unfavorited observation look like it doesn't
// exist — but it still beats refusing to show anything.
const loadObservationsCache = async (
  userId?: number,
): Promise<UserObservationsCache> => {
  try {
    const apiToken = await getJWT( );
    return await syncUserObservations( userId, { api_token: apiToken } );
  } catch ( error ) {
    logger.warn( "Falling back to the last synced observations", error );
    return userId
      ? readUserObservationsCache( userId )
      : new Map( );
  }
};

const DevicePhotoCleanup = ( ) => {
  const realm = useRealm( );
  const currentUser = useCurrentUser( );
  const currentUserId = currentUser?.id;
  const [days, setDays] = useState<UnfavoritedPhotoDay[]>( [] );
  const [loading, setLoading] = useState( true );
  const [syncingFaves, setSyncingFaves] = useState( true );
  const [showConfirm, setShowConfirm] = useState( false );
  const [deleting, setDeleting] = useState( false );
  const [deletedCount, setDeletedCount] = useState<number | null>( null );
  const [fullScreenUri, setFullScreenUri] = useState<string | null>( null );

  useEffect( ( ) => {
    let cancelled = false;
    setLoading( true );
    setSyncingFaves( true );
    // Sync the shared observation cache before matching. A fave toggled on
    // another device or in the website isn't here yet, and scanning against
    // stale faves is what makes freshly unfavorited observations look like they
    // don't exist. The library scan doesn't depend on that answer, though, so
    // start it now and let the two waits overlap instead of stacking. With
    // nothing synced yet there's no way to know which era to scan, so the scan
    // waits for the sync in that one case.
    const lastSynced = currentUserId
      ? readUserObservationsCache( currentUserId )
      : undefined;
    const assets = lastSynced?.size
      ? prefetchDeviceAssets( realm, lastSynced )
      : undefined;
    loadObservationsCache( currentUserId )
      .then( cache => {
        if ( !cancelled ) {
          setSyncingFaves( false );
        }
        return findUnfavoritedDevicePhotoDays( realm, assets, cache );
      } )
      .then( result => {
        if ( !cancelled ) {
          setDays( result );
        }
      } )
      .finally( ( ) => {
        if ( !cancelled ) {
          setSyncingFaves( false );
          setLoading( false );
        }
      } );
    return ( ) => {
      cancelled = true;
    };
  }, [realm, currentUserId] );

  const allUris = useMemo(
    ( ) => days.flatMap( day => day.uris ),
    [days],
  );

  const { width } = useWindowDimensions( );
  const tileSize = width / GRID_COLUMNS;
  // Stable identity so recycled tiles don't remount on every render.
  const tileStyle = useMemo(
    ( ) => ( { height: tileSize, width: tileSize } ),
    [tileSize],
  );
  const gridRows = useMemo(
    ( ) => buildGridRows( days, GRID_COLUMNS ),
    [days],
  );

  const confirmDelete = useCallback( async ( ) => {
    // Dismiss the confirmation sheet and let it fully animate out before
    // deleting. iOS can't present its own system deletion confirmation while a
    // modal (this BottomSheet) is on screen, so calling deletePhotos with the
    // sheet still up makes the native request hang and never present.
    setShowConfirm( false );
    setDeleting( true );
    await new Promise( resolve => { setTimeout( resolve, 600 ); } );
    await deleteOriginalDevicePhotos( allUris, { userInitiated: true } );
    setDeletedCount( allUris.length );
    setDays( [] );
    setDeleting( false );
  }, [allUris] );

  if ( deletedCount !== null ) {
    return (
      <ViewWrapper>
        <View className="p-5 items-center justify-center flex-1">
          <Heading4>
            {`Deleted ${deletedCount} photo${deletedCount === 1
              ? ""
              : "s"}`}
          </Heading4>
        </View>
      </ViewWrapper>
    );
  }

  if ( loading ) {
    return (
      <ViewWrapper>
        <View className="p-5 items-center justify-center flex-1">
          <ActivityIndicator size={40} />
          <Body2 className="mt-4 text-center">
            {syncingFaves
              ? "Checking your faves and scanning your photo library…"
              : "Matching photos to your observations…"}
          </Body2>
        </View>
      </ViewWrapper>
    );
  }

  if ( allUris.length === 0 ) {
    return (
      <ViewWrapper>
        <View className="p-5 items-center justify-center flex-1">
          <Heading4>No matching photos found</Heading4>
          <Body2 className="mt-2 text-center">
            None of the photos in your library match an unfavorited observation.
          </Body2>
        </View>
      </ViewWrapper>
    );
  }

  return (
    <ViewWrapper>
      <View className="px-5 pt-4 pb-2">
        <Body2>
          {`${allUris.length} photo${allUris.length === 1
            ? ""
            : "s"} in your library match observations you haven't favorited.`}
        </Body2>
      </View>
      <FlashList
        data={gridRows}
        keyExtractor={row => row.key}
        style={styles.list}
        contentContainerStyle={styles.scrollContent}
        renderItem={( { item } ) => ( item.type === "header"
          ? <Heading4 className="px-5 py-2">{item.label}</Heading4>
          : (
            <View className="flex-row">
              {item.uris.map( uri => (
                <Pressable
                  key={uri}
                  accessibilityRole="button"
                  onPress={( ) => setFullScreenUri( uri )}
                >
                  <DevicePhotoThumbnail
                    uri={uri}
                    size={tileSize}
                    style={tileStyle}
                  />
                </Pressable>
              ) )}
            </View>
          ) )}
      />
      <View className="absolute bottom-0 left-0 right-0 p-4 bg-white border-t border-lightGray">
        <Button
          level="warning"
          text={`DELETE ${allUris.length} PHOTO${allUris.length === 1
            ? ""
            : "S"}`}
          onPress={( ) => setShowConfirm( true )}
        />
      </View>
      {showConfirm && (
        <BottomSheet
          onPressClose={( ) => setShowConfirm( false )}
          headerText="DELETE PHOTOS?"
        >
          <View className="p-5">
            <Heading4 className="mb-1">
              {`Deleting ${allUris.length} photo${allUris.length === 1
                ? ""
                : "s"}`}
            </Heading4>
            <List2 className="mb-4">
              These will be permanently removed from your device&apos;s photo
              library. Your iNaturalist observations keep their own copies.
            </List2>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="mb-5"
            >
              {allUris.slice( 0, CONFIRM_PREVIEW_LIMIT ).map( uri => (
                <DevicePhotoThumbnail
                  key={uri}
                  uri={uri}
                  size={THUMB_SIZE}
                  style={styles.thumb}
                />
              ) )}
              {allUris.length > CONFIRM_PREVIEW_LIMIT && (
                <View
                  style={styles.thumb}
                  className="items-center justify-center bg-lightGray"
                >
                  <Body2>{`+${allUris.length - CONFIRM_PREVIEW_LIMIT}`}</Body2>
                </View>
              )}
            </ScrollView>
            <ButtonBar
              buttonConfiguration={[
                {
                  title: "CANCEL",
                  onPress: ( ) => setShowConfirm( false ),
                  isPrimary: false,
                },
                {
                  title: `DELETE ${allUris.length}`,
                  onPress: confirmDelete,
                  level: "warning",
                  loading: deleting,
                  disabled: deleting,
                  isPrimary: false,
                  className: "grow ml-3",
                },
              ]}
            />
          </View>
        </BottomSheet>
      )}
      <Modal
        showModal={!!fullScreenUri}
        fullScreen
        closeModal={( ) => setFullScreenUri( null )}
        backdropOpacity={1}
        modal={(
          <Pressable
            className="flex-1 bg-black"
            accessibilityRole="button"
            onPress={( ) => setFullScreenUri( null )}
          >
            {fullScreenUri && (
              <Image
                source={{ uri: fullScreenUri }}
                style={styles.fullScreenImage}
                resizeMode="contain"
              />
            )}
          </Pressable>
        )}
      />
    </ViewWrapper>
  );
};

export default DevicePhotoCleanup;
