/**
 * Metro configuration for React Native
 * https://reactnative.dev/docs/metro
 * with added config for react-native-svg-transformer
 * https://www.npmjs.com/package/react-native-svg-transformer?activeTab
 *
 * @format
 */
// eslint-disable-next-line import/no-unresolved
const { getDefaultConfig, mergeConfig } = require( "@react-native/metro-config" );
const { withRozenite } = require( "@rozenite/metro" );
const {
  withRozeniteRequireProfiler,
} = require( "@rozenite/require-profiler-plugin/metro" );
const writeAppCommit = require( "./scripts/writeAppCommit" );

const {
  resolver: { sourceExts, assetExts },
} = getDefaultConfig();

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
    babelTransformerPath: require.resolve( "react-native-svg-transformer/react-native" ),
  },
  resolver: {
    assetExts: assetExts.filter( ext => ext !== "svg" ),
    sourceExts:
      process.env.MOCK_MODE === "e2e"
        ? ["e2e-mock", ...sourceExts, "svg"]
        : [...sourceExts, "svg"],
    nodeModulesPaths: [...localPackagePaths],
  },
  watchFolders: [...localPackagePaths],
};

const mergedConfig = mergeConfig( getDefaultConfig( __dirname ), config );

// Stamp the git commit once here, at config load, so the module exists before
// Metro resolves anything. The per-build hook below cannot do this job alone:
// it runs after dependency resolution, so it can refresh a stale stamp but not
// create a missing one, and the file is gitignored. Until now it was written by
// `postinstall`, which meant a build that skipped `npm ci` never had it — the
// Sep 23 TestFlight archive failed outright on `Unable to resolve module
// sharedHelpers/appCommit` the first time the CI node_modules cache hit.
writeAppCommit( );

// And again before every bundle build, for freshness. Stamping only at config
// load would cover just the bundle built by that Metro process: a dev server
// started before a rebase keeps serving newly pulled code under the commit it
// happened to start on, which is the failure this is here to prevent. Metro
// calls this at the start of each graph build, so `start`, `run-ios`,
// `run-android` and `react-native bundle` are all covered. writeAppCommit only
// touches the file when the commit actually changes, so the module Metro
// watches is invalidated once per checkout rather than once per reload.
const { getTransformOptions } = mergedConfig.transformer;
mergedConfig.transformer.getTransformOptions = async ( ...args ) => {
  writeAppCommit( );
  return getTransformOptions
    ? getTransformOptions( ...args )
    : {};
};

module.exports = withRozenite(
  mergedConfig,
  {
    enabled: process.env.WITH_ROZENITE === "true",
    enhanceMetroConfig: config => withRozeniteRequireProfiler( config ),
  },
);
