/**
 * Metro configuration for React Native
 * https://reactnative.dev/docs/metro
 * with added config for react-native-svg-transformer
 * https://www.npmjs.com/package/react-native-svg-transformer?activeTab
 * and Expo / EAS (expo/metro-config).
 *
 * @format
 */
// eslint-disable-next-line import/no-unresolved
const { mergeConfig } = require( "@react-native/metro-config" );
const { getDefaultConfig: getExpoDefaultConfig } = require( "expo/metro-config" );
const { withRozenite } = require( "@rozenite/metro" );
const {
  withRozeniteRequireProfiler,
} = require( "@rozenite/require-profiler-plugin/metro" );

const expoConfig = getExpoDefaultConfig( __dirname );

const {
  resolver: { sourceExts, assetExts },
} = expoConfig;

const localPackagePaths = [
  // If you reference any local paths in package.json, you'll need to list them here
];

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  transformer: {
    ...expoConfig.transformer,
    babelTransformerPath: require.resolve( "react-native-svg-transformer/react-native" ),
  },
  resolver: {
    ...expoConfig.resolver,
    assetExts: assetExts.filter( ext => ext !== "svg" ),
    sourceExts:
      process.env.MOCK_MODE === "e2e"
        ? ["e2e-mock", ...sourceExts, "svg"]
        : [...sourceExts, "svg"],
    nodeModulesPaths: [...( expoConfig.resolver?.nodeModulesPaths || [] ), ...localPackagePaths],
  },
  watchFolders: [...( expoConfig.watchFolders || [] ), ...localPackagePaths],
};

module.exports = withRozenite(
  mergeConfig( expoConfig, config ),
  {
    enabled: process.env.WITH_ROZENITE === "true",
    enhanceMetroConfig: cfg => withRozeniteRequireProfiler( cfg ),
  },
);
