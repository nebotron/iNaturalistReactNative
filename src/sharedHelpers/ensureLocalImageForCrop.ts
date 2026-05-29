import { CachesDirectoryPath, downloadFile, mkdir } from "@dr.pogodin/react-native-fs";
import * as uuid from "uuid";

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

const ensureLocalImageForCrop = async ( uri: string ): Promise<string> => {
  if ( uri.match( /^https?:\/\// ) ) {
    const cacheDir = `${CachesDirectoryPath}/inatCropSources`;
    await mkdir( cacheDir );
    const destPath = `${cacheDir}/${uuid.v4()}.jpg`;
    const downloadUrl = uri.replace( /square/i, "large" );
    await downloadFile( {
      fromUrl: downloadUrl,
      toFile: destPath,
    } ).promise;
    return `file://${destPath}`;
  }

  if ( uri.startsWith( "/" ) ) {
    return `file://${uri}`;
  }

  return uri;
};

export default ensureLocalImageForCrop;

export { stripFilePrefix };
