/* eslint-disable i18next/no-literal-string */
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import DevicePhotoGrid from "components/PhotoImporter/DevicePhotoGrid";
import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import {
  ActivityIndicator,
  Body2,
  Button,
  Heading4,
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
  NativeModules,
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { log } from "sharedHelpers/logger";
import { deleteOriginalDevicePhotos } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import type { UnfavoritedPhotoDay } from "sharedHelpers/unfavoritedDevicePhotos";
import findUnfavoritedDevicePhotoDays, {
  prefetchDeviceAssets,
} from "sharedHelpers/unfavoritedDevicePhotos";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";
import type { UserObservationsCache } from "sharedHelpers/userObservationsCache";
import {
  readUserObservationsCache,
  syncUserObservations,
} from "sharedHelpers/userObservationsCache";
import { useCurrentUser, useGridLayout } from "sharedHooks";

const logger = log.extend( "DevicePhotoCleanup" );

const { ImageCropper } = NativeModules as {
  ImageCropper?: { photoDeleteProbe?: ( phUris: string[] ) => Promise<string> };
};

const { useRealm } = RealmContext;

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
} );

// One cell of the virtualized grid: a single photo. This is the same shape the
// photo picker feeds DevicePhotoGrid, so both screens get identical
// virtualization and thumbnail prefetching.
type CleanupGridItem = { type: "photo"; id: string; uri: string };

// One continuous grid, newest first: the days are only how the scan groups its
// work, not something the user is asked to read.
const buildGridItems = ( days: UnfavoritedPhotoDay[] ): CleanupGridItem[] => days
  .flatMap( day => day.uris.map( uri => ( { type: "photo" as const, id: uri, uri } ) ) );

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
  const [deleting, setDeleting] = useState( false );
  const [deletedCount, setDeletedCount] = useState<number | null>( null );
  const [undeletableCount, setUndeletableCount] = useState( 0 );
  const [probing, setProbing] = useState( false );
  const [fullScreenUri, setFullScreenUri] = useState<string | null>( null );
  const [stillDeleting, setStillDeleting] = useState( false );
  const [rescans, setRescans] = useState( 0 );

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
    const scan = lastSynced?.size
      ? prefetchDeviceAssets( realm, lastSynced )
      : undefined;
    const startedAt = Date.now( );
    let syncedAt = startedAt;
    loadObservationsCache( currentUserId )
      .then( cache => {
        if ( !cancelled ) {
          setSyncingFaves( false );
        }
        syncedAt = Date.now( );
        return findUnfavoritedDevicePhotoDays( realm, scan, cache );
      } )
      .then( result => {
        // How long the user sat on the spinner, split into the two waits, so
        // the app log can say which one to shorten next.
        logger.info(
          `Found ${result.reduce( ( count, day ) => count + day.uris.length, 0 )} `
          + `photo(s) in ${Date.now( ) - startedAt}ms `
          + `(sync ${syncedAt - startedAt}ms, match ${Date.now( ) - syncedAt}ms)`,
        );
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
  }, [realm, currentUserId, rescans] );

  const allUris = useMemo(
    ( ) => days.flatMap( day => day.uris ),
    [days],
  );

  const { gridItemStyle, gridItemWidth, numColumns } = useGridLayout( undefined, "threeUp" );
  const gridItems = useMemo( ( ) => buildGridItems( days ), [days] );

  const renderHeader = useCallback( ( ) => null, [] );

  const renderPhoto = useCallback( ( item: CleanupGridItem ) => (
    <DevicePhotoImage
      uri={item.uri}
      cellWidth={gridItemWidth}
      style={gridItemStyle}
      onPress={( ) => setFullScreenUri( item.uri )}
    />
  ), [gridItemStyle, gridItemWidth] );

  const getPhotoUri = useCallback( ( item: CleanupGridItem ) => item.uri, [] );

  // The grid's already-generated thumbnail (same size, so it's a cache hit)
  // fills the full-screen view immediately while the full-resolution asset
  // loads, instead of showing black. Requested at the grid cell size so it
  // reuses the exact cache entry the tapped tile used.
  const fullScreenThumbUri = useDeviceImageThumbnail(
    fullScreenUri ?? undefined,
    PixelRatio.getPixelSizeForLayoutSize( gridItemWidth || 128 ),
  );

  const deletePhotos = useCallback( async ( ) => {
    setDeleting( true );
    setStillDeleting( false );
    // Report what the OS actually deleted. A wedged PHPhotoLibrary deletes
    // nothing yet resolves normally, and
    // claiming "Deleted 1,159 photos" while the photos are all still there is
    // worse than saying nothing happened.
    const {
      deleted, succeeded, pending, undeletable,
    } = await deleteOriginalDevicePhotos(
      allUris,
      { userInitiated: true },
    );
    setDeleting( false );
    // PhotoKit hasn't answered but is still holding the transaction, and it
    // usually goes through afterwards. Rescanning is the only honest thing to
    // show: the photos left in the grid may already be gone.
    if ( pending ) {
      setStillDeleting( true );
      setRescans( count => count + 1 );
      return;
    }
    // Leave the grid up when the delete didn't go through so the user can
    // retry; the helper has already explained the failure with an alert.
    if ( !succeeded ) return;
    setDeletedCount( deleted );
    setUndeletableCount( undeletable ?? 0 );
    setDays( [] );
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
          {undeletableCount > 0 && (
            <Body2 className="mt-4 text-center">
              {`${undeletableCount} photo${undeletableCount === 1
                ? ""
                : "s"} could not be deleted: iOS only lets the Photos app delete `
                + "photos synced from a computer or belonging to a shared album."}
            </Body2>
          )}
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
      {stillDeleting && (
        <View className="px-5 pt-4 pb-2">
          <Body2>
            The last delete hasn&apos;t come back from iOS yet. These are what is still
            in your library — it may finish on its own, or a restart may be needed.
          </Body2>
        </View>
      )}
      <View style={styles.list}>
        <DevicePhotoGrid
          items={gridItems}
          numColumns={numColumns}
          itemWidth={gridItemWidth}
          renderHeader={renderHeader}
          renderPhoto={renderPhoto}
          getPhotoUri={getPhotoUri}
          contentContainerStyle={styles.scrollContent}
        />
      </View>
      <View className="absolute bottom-0 left-0 right-0 p-4 bg-white border-t border-lightGray">
        <Button
          level="warning"
          text={`DELETE ${allUris.length} PHOTO${allUris.length === 1
            ? ""
            : "S"}`}
          onPress={deletePhotos}
          loading={deleting}
          disabled={deleting}
        />
        {/* Asks PhotoKit two questions about the stuck photos: whether a
            transaction that modifies one comes back, and whether this app can
            put an alert on screen at all. See photoDeleteProbe in
            ImageCropper.m for what each answer rules out. */}
        <Button
          className="mt-2"
          text="RUN PHOTOS PROBE"
          disabled={deleting || probing}
          loading={probing}
          onPress={async ( ) => {
            setProbing( true );
            try {
              const result = await ImageCropper?.photoDeleteProbe?.( allUris );
              logger.errorWithExtra( "photo_delete_probe", {
                photos: allUris.length,
                result: result ?? "probe unavailable",
              } );
            } finally {
              setProbing( false );
            }
          }}
        />
        {deleting && (
          <Body2 className="mt-2 text-center">
            iOS confirms and carries out the deletion itself, which can take a while.
          </Body2>
        )}
      </View>
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
            {fullScreenThumbUri && (
              <Image
                source={{ uri: fullScreenThumbUri }}
                style={StyleSheet.absoluteFill}
                resizeMode="contain"
              />
            )}
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
