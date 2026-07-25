/* eslint-disable i18next/no-literal-string */
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
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Image,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { deleteOriginalDevicePhotos } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { addRemovedDevicePhotoUris } from "sharedHelpers/removedDevicePhotoUris";
import type { UnfavoritedPhotoDay } from "sharedHelpers/unfavoritedDevicePhotos";
import findUnfavoritedDevicePhotoDays from "sharedHelpers/unfavoritedDevicePhotos";

const { useRealm } = RealmContext;

const THUMB_SIZE = 78;
// Cap how many thumbnails we render in the confirmation preview strip so a
// huge selection doesn't bog the sheet down; the count still reflects all.
const CONFIRM_PREVIEW_LIMIT = 30;

const styles = StyleSheet.create( {
  scrollContent: {
    paddingBottom: 100,
  },
  thumb: {
    borderRadius: 4,
    height: THUMB_SIZE,
    margin: 3,
    width: THUMB_SIZE,
  },
} );

const DevicePhotoCleanup = ( ) => {
  const realm = useRealm( );
  const [days, setDays] = useState<UnfavoritedPhotoDay[]>( [] );
  const [loading, setLoading] = useState( true );
  const [showConfirm, setShowConfirm] = useState( false );
  const [deleting, setDeleting] = useState( false );
  const [deletedCount, setDeletedCount] = useState<number | null>( null );

  useEffect( ( ) => {
    let cancelled = false;
    setLoading( true );
    findUnfavoritedDevicePhotoDays( realm )
      .then( result => {
        if ( !cancelled ) {
          setDays( result );
        }
      } )
      .finally( ( ) => {
        if ( !cancelled ) {
          setLoading( false );
        }
      } );
    return ( ) => {
      cancelled = true;
    };
  }, [realm] );

  const allUris = useMemo(
    ( ) => days.flatMap( day => day.uris ),
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
    // Recorded regardless of whether the native deletion below actually
    // succeeds (see removedDevicePhotoUris.ts) so these stay hidden from the
    // photo picker even if iOS's PHPhotoLibrary confirmation silently no-ops it.
    addRemovedDevicePhotoUris( allUris );
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
            Scanning your photo library…
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
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {days.map( day => (
          <View key={day.dateKey} className="px-3 pb-3">
            <Heading4 className="px-2 py-2">{day.label}</Heading4>
            <View className="flex-row flex-wrap">
              {day.uris.map( uri => (
                <Image
                  key={uri}
                  source={{ uri }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
              ) )}
            </View>
          </View>
        ) )}
      </ScrollView>
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
                <Image
                  key={uri}
                  source={{ uri }}
                  style={styles.thumb}
                  resizeMode="cover"
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
    </ViewWrapper>
  );
};

export default DevicePhotoCleanup;
