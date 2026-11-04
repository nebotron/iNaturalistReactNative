import ImportProgressBanner from "components/SharedComponents/ImportProgressBanner";
import React from "react";
import { StyleSheet, View } from "react-native";
import { useTranslation } from "sharedHooks";
import useUsbImportProgress from "stores/usbImportProgress";

// Non-blocking status banner shown while useUsbImport offloads photos from
// a USB device into the Photos library and clears them from the device. It sits
// above the tab bar and uses pointerEvents="none" so the rest of the app stays
// fully usable during the import.
const styles = StyleSheet.create( {
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 100,
    alignItems: "center",
    paddingHorizontal: 16,
  },
} );

const UsbImportProgress = ( ) => {
  const { t } = useTranslation( );
  const {
    active, phase, total, saved, failed, deleted, note,
  } = useUsbImportProgress( );

  if ( !active ) return null;

  const finished = phase === "done" || phase === "error";

  let title;
  let detail;
  if ( phase === "waitingForSpace" ) {
    title = t( "Waiting-for-space" );
    detail = t( "Saved-X-of-Y-free-up-space-to-continue", { saved, total } );
  } else if ( phase === "deleting" ) {
    title = t( "Clearing-the-storage-device" );
    detail = t( "Saved-X-of-Y-removing-them-from-the-device", { saved, total } );
  } else if ( phase === "done" ) {
    title = t( "Import-complete" );
    detail = deleted > 0
      ? t( "Saved-X-photos-to-your-library-and-cleared-Y", { count: saved, deleted } )
      : t( "Saved-X-photos-to-your-library", { count: saved } );
  } else if ( phase === "error" ) {
    title = t( "Import-finished-with-errors" );
    // Without the note a device that ran out of room reads as the app failing
    // at random — "Saved 0 of 157" and nothing to act on.
    detail = note || t( "Saved-X-of-Y", { saved, total } );
  } else {
    title = t( "Importing-photos-to-your-library" );
    detail = t( "X-of-Y", { x: saved, y: total } );
  }

  return (
    <View style={styles.wrap} pointerEvents="none">
      <ImportProgressBanner
        title={title}
        detail={detail}
        warning={failed > 0
          ? t( "X-failed", { count: failed } )
          : undefined}
        completed={saved + failed}
        total={total}
        showSpinner={!finished}
      />
    </View>
  );
};

export default UsbImportProgress;
