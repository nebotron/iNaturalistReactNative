import { ActivityIndicator } from "components/SharedComponents";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
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
  banner: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 360,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  text: {
    marginLeft: 12,
    flexShrink: 1,
  },
  title: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  detail: {
    color: "#d4d4d4",
    fontSize: 12,
    marginTop: 2,
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
    title = "Import complete";
    detail = `Saved ${saved} photo${saved === 1 ? "" : "s"} to your library`
      + `${deleted > 0 ? ` and cleared ${deleted} from the device` : ""}.`;
  } else if ( phase === "error" ) {
    title = "Import finished with errors";
    detail = `Saved ${saved} of ${total}${failed > 0 ? `, ${failed} failed` : ""}.`;
  } else {
    title = "Importing photos to your library…";
    detail = `${saved} of ${total}`;
  }

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.banner}>
        {!finished && <ActivityIndicator size={18} />}
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.detail}>{detail}</Text>
        </View>
      </View>
    </View>
  );
};

export default UsbImportProgress;
