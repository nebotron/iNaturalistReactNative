import { getApps } from "@react-native-firebase/app";

// The native side skips Firebase configuration when GoogleService-Info.plist
// holds placeholder values (see AppDelegate), leaving no [DEFAULT] app. Any
// RNFB call then throws "No Firebase app [DEFAULT] has been created", so
// callers must check this first.
export const isFirebaseConfigured = ( ): boolean => getApps( ).length > 0;

export default isFirebaseConfigured;
