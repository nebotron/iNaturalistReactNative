const fs = require( "fs" );
const path = require( "path" );
const appJson = require( "./app.json" );

// Link once with `eas init` (writes projectId here) or set EAS_PROJECT_ID for CI.
const easProjectIdFromFile = ( () => {
  const idPath = path.join( __dirname, ".eas-project-id" );
  if ( fs.existsSync( idPath ) ) {
    return fs.readFileSync( idPath, "utf8" ).trim();
  }
  return null;
} )();

// Default from `eas init` (@bfhannel/inaturalist-react-native); override with EAS_PROJECT_ID or .eas-project-id.
const defaultEasProjectId = "c9d3dfd4-5fab-460b-8d1e-0a038461d319";

const easProjectId = process.env.EAS_PROJECT_ID || easProjectIdFromFile || defaultEasProjectId;

/** @type {import('@expo/config').ExpoConfig} */
module.exports = {
  name: appJson.displayName || appJson.name,
  slug: "inaturalist-react-native",
  scheme: "inaturalist",
  version: "1.0.21",
  orientation: "default",
  platforms: ["ios", "android"],
  ios: {
    bundleIdentifier: "org.inaturalist.iNaturalistMobile",
    buildNumber: "212",
  },
  android: {
    package: "org.inaturalist.iNaturalistMobile",
    versionCode: 212,
  },
  extra: {
    ...( easProjectId
      ? { eas: { projectId: easProjectId } }
      : {} ),
  },
};
