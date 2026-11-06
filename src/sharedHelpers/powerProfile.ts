import { NativeModules } from "react-native";

// Tells iOS which screen is in front, so the daily MetricKit report splits the
// app's CPU time and disk writes by screen ("metrickit_signpost" in the app
// log). See ios/iNaturalistReactNative/PowerProfile.h. A no-op on Android,
// which has no such module.
interface PowerProfileModule {
  setScreen: ( screen: string ) => void;
}

const powerProfile = ( NativeModules as {
  PowerProfile?: PowerProfileModule;
} ).PowerProfile;

const setPowerProfileScreen = ( screen: string | undefined ) => {
  if ( screen ) powerProfile?.setScreen( screen );
};

export default setPowerProfileScreen;
