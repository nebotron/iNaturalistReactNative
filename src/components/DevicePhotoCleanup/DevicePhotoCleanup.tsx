/* eslint-disable i18next/no-literal-strings */
import {
  Body2,
  Button,
  Heading4,
  ViewWrapper,
  WarningSheet,
} from "components/SharedComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
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
import findUnfavoritedDevicePhotoDays from "sharedHelpers/unfavoritedDevicePhotos";

const { useRealm } = RealmContext;

const THUMB_SIZE = 78;

const styles = StyleSheet.create( {
  thumb: {
    borderRadius: 4,
    height: THUMB_SIZE,
    margin: 3,
    width: THUMB_SIZE,
  },
} );

const DevicePhotoCleanup = ( ) => {
  const realm = useRealm( );
  const initialDays = useMemo(
    ( ) => findUnfavoritedDevicePhotoDays( realm ),
    [realm],
  );
  const [days, setDays] = useState( initialDays );
  const [showConfirm, setShowConfirm] = useState( false );
  const [deleting, setDeleting] = useState( false );
  const [deletedCount, setDeletedCount] = useState<number | null>( null );

  const allUris = useMemo(
    ( ) => days.flatMap( day => day.uris ),
    [days],
  );

  const confirmDelete = useCallback( async ( ) => {
    setDeleting( true );
    await deleteOriginalDevicePhotos( allUris, { userInitiated: true } );
    setDeletedCount( allUris.length );
    setDays( [] );
    setDeleting( false );
    setShowConfirm( false );
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
      <ScrollView contentContainerStyle={{ paddingBottom: 100 }}>
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
        <WarningSheet
          onPressClose={( ) => setShowConfirm( false )}
          headerText="DELETE PHOTOS?"
          text={`This will permanently delete ${allUris.length} photo${allUris.length === 1
            ? ""
            : "s"} from your device's photo library. Your iNaturalist observations will keep their own copies.`}
          buttonText="DELETE"
          confirm={confirmDelete}
          handleSecondButtonPress={( ) => setShowConfirm( false )}
          secondButtonText="CANCEL"
          loading={deleting}
        />
      )}
    </ViewWrapper>
  );
};

export default DevicePhotoCleanup;
