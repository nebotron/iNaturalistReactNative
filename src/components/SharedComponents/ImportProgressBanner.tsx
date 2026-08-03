import { ActivityIndicator } from "components/SharedComponents";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ProgressBar } from "react-native-paper";
import colors from "styles/tailwindColors";

// Dark rounded card reporting the progress of a long-running import: a
// spinner, a title, a "3 of 12"-style detail line and a determinate bar. Used
// by both the USB offload banner (UsbImportProgress) and the photo picker's
// import overlay so the two flows read the same.
const styles = StyleSheet.create( {
  banner: {
    width: "100%",
    maxWidth: 360,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.85)",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  text: {
    flexShrink: 1,
  },
  spinner: {
    marginRight: 12,
  },
  title: {
    color: colors.white,
    fontSize: 15,
    fontWeight: "600",
  },
  detail: {
    color: "#d4d4d4",
    fontSize: 12,
    marginTop: 2,
  },
  bar: {
    height: 6,
    marginTop: 12,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
} );

interface Props {
  title: string;
  detail?: string;
  completed?: number;
  total?: number;
  showSpinner?: boolean;
}

const ImportProgressBanner = ( {
  title,
  detail,
  completed = 0,
  total = 0,
  showSpinner = true,
}: Props ) => (
  <View style={styles.banner}>
    <View style={styles.row}>
      {showSpinner && (
        <View style={styles.spinner}>
          <ActivityIndicator size={18} />
        </View>
      )}
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {!!detail && <Text style={styles.detail}>{detail}</Text>}
      </View>
    </View>
    {total > 0 && (
      <ProgressBar
        progress={Math.min( completed / total, 1 )}
        color={colors.inatGreen}
        style={styles.bar}
      />
    )}
  </View>
);

export default ImportProgressBanner;
