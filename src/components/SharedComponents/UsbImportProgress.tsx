import {
  ActivityIndicator,
  Body3,
  Heading4,
} from "components/SharedComponents";
import React from "react";
import { Modal, StyleSheet, View } from "react-native";
import useUsbImportProgress from "stores/usbImportProgress";

// Full-screen overlay shown while useUsbAutoImport offloads photos from a USB
// device into the Photos library and clears them from the device. Text is kept
// intentionally simple/English here as this is an iOS-first utility flow.
const styles = StyleSheet.create( {
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  card: {
    width: "100%",
    maxWidth: 320,
    alignItems: "center",
    padding: 24,
    borderRadius: 16,
    backgroundColor: "#ffffff",
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
    <Modal transparent visible animationType="fade">
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {!finished && <ActivityIndicator size={40} />}
          <Heading4 className="mt-4 text-center">{title}</Heading4>
          <Body3 className="mt-2 text-center">{detail}</Body3>
        </View>
      </View>
    </Modal>
  );
};

export default UsbImportProgress;
