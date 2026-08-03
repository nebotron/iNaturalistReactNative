import ImportProgressBanner from "components/SharedComponents/ImportProgressBanner";
import React from "react";
import { StyleSheet, View } from "react-native";
import useUsbImportProgress from "stores/usbImportProgress";

// Non-blocking status banner shown while useUsbAutoImport offloads photos from
// a USB device into the Photos library and clears them from the device. It sits
// above the tab bar and uses pointerEvents="none" so the rest of the app stays
// fully usable during the import. Text is intentionally simple/English here as
// this is an iOS-first utility flow.
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
  const {
    active, phase, total, saved, failed, deleted,
  } = useUsbImportProgress( );

  if ( !active ) return null;

  const finished = phase === "done" || phase === "error";

  let title;
  let detail;
  if ( phase === "deleting" ) {
    title = "Clearing the storage device…";
    detail = `Saved ${saved} of ${total}. Removing them from the device…`;
  } else if ( phase === "done" ) {
    const plural = saved === 1
      ? ""
      : "s";
    const cleared = deleted > 0
      ? ` and cleared ${deleted} from the device`
      : "";
    title = "Import complete";
    detail = `Saved ${saved} photo${plural} to your library${cleared}.`;
  } else if ( phase === "error" ) {
    const failures = failed > 0
      ? `, ${failed} failed`
      : "";
    title = "Import finished with errors";
    detail = `Saved ${saved} of ${total}${failures}.`;
  } else {
    title = "Importing photos to your library…";
    detail = `${saved} of ${total}`;
  }

  return (
    <View style={styles.wrap} pointerEvents="none">
      <ImportProgressBanner
        title={title}
        detail={detail}
        completed={saved + failed}
        total={total}
        showSpinner={!finished}
      />
    </View>
  );
};

export default UsbImportProgress;
