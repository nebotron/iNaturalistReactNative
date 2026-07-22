import { copyAssetsFileIOS, mkdir } from "@dr.pogodin/react-native-fs";
import { Realm } from "@realm/react";
import type { ApiPhoto } from "api/types";
import { photoUploadPath } from "appConstants/paths";
import { Platform } from "react-native";
import type { RealmPhoto } from "realmModels/types";
import {
  cropOriginalUriFromPath,
  normalizedCropToStorage,
  preserveCropOriginalPath,
  savedNormalizedCrop,
} from "sharedHelpers/cropPhotoMetadata";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import resizeImage from "sharedHelpers/resizeImage";
import { unlink } from "sharedHelpers/util";

class Photo extends Realm.Object {
  static PHOTO_FIELDS = {
    id: true,
    attribution: true,
    license_code: true,
    url: true,
    hidden: true,
  } as const;

  static mapApiToRealm( photo: ApiPhoto, _realm = null ) {
    const localPhoto = {
      ...photo,
      _synced_at: new Date( ),
    };
    localPhoto.licenseCode = localPhoto.licenseCode || photo?.license_code;
    return localPhoto;
  }

  static async resizeImageForUpload( pathOrUri: string ): Promise<string> {
    // Cap the largest dimension so uploads stay well under the API's payload
    // limit. Uploading full-resolution originals made /v2/photos reject the
    // request with HTTP 413 (Payload Too Large), failing the whole upload.
    // The resizer keeps EXIF metadata (keepMeta) and only scales down.
    const width = 2048;
    await mkdir( photoUploadPath );

    // iOS PHAsset: resize on copy. We don't have a real local file path that
    // the image resizer can use, so resize via react-native-fs instead.
    if ( Platform.OS === "ios" && pathOrUri.match( /^ph:/ ) ) {
      const iosLocalIdentifierMatches = pathOrUri.match( /^ph:\/\/([^/]+)/ );
      const outFilename = iosLocalIdentifierMatches
        ? `${iosLocalIdentifierMatches[1]}.jpeg`
        : pathOrUri.split( "/" ).slice( -1 ).pop( );
      const outPath = `${photoUploadPath}/${outFilename}`;
      return copyAssetsFileIOS( pathOrUri, outPath, width, width );
    }

    // Work around path / uri bug: https://github.com/bamlab/react-native-image-resizer/issues/328
    let uriForResize = pathOrUri;
    if ( Platform.OS === "ios" && uriForResize.match( /^\// ) ) {
      uriForResize = `file://${uriForResize}`;
    }

    return resizeImage( uriForResize, {
      width,
      outputPath: photoUploadPath,
      imageOptions: {
        mode: "contain",
        onlyScaleDown: true,
      },
    } );
  }

  static async new( uri: string ) {
    const localFilePath = await Photo.resizeImageForUpload( uri );
    return {
      _created_at: new Date( ),
      _updated_at: new Date( ),
      localFilePath,
    };
  }

  // this is necessary because photos cannot be found reliably via the file:/// name.
  // without this, local photos will not show up when the app updates
  static getLocalPhotoUri( localPathOrUri?: string ) {
    const pieces = localPathOrUri?.split( "photoUploads/" );
    if ( !pieces || pieces.length <= 1 ) return null;
    return `file://${photoUploadPath}/${pieces[1]}`;
  }

  static hasLocalEdits( photo?: RealmPhoto ) {
    if ( !photo?.localFilePath || !photo._updated_at ) {
      return false;
    }

    return !photo._synced_at || photo._synced_at <= photo._updated_at;
  }

  static preferredLocalPhotoUri( photo?: RealmPhoto ) {
    const localUri = Photo.getLocalPhotoUri( photo?.localFilePath );
    if ( Photo.hasLocalEdits( photo ) && localUri ) {
      return localUri;
    }

    return null;
  }

  static displayLargePhoto( url?: string ) {
    return url?.replace( "square", "large" );
  }

  static displayMediumPhoto( url?: string ) {
    return url?.replace( "square", "medium" );
  }

  static displayOriginalPhoto( url?: string ) {
    return url?.replace( "square", "original" );
  }

  static displayLocalOrRemoteOriginalPhoto( photo: RealmPhoto ) {
    return (
      Photo.preferredLocalPhotoUri( photo )
      || Photo.displayOriginalPhoto( photo?.url )
      || Photo.getLocalPhotoUri( photo?.localFilePath )
    );
  }

  static displayLocalOrRemoteLargePhoto( photo: RealmPhoto ) {
    return (
      Photo.preferredLocalPhotoUri( photo )
      || Photo.displayLargePhoto( photo?.url )
      || Photo.getLocalPhotoUri( photo?.localFilePath )
    );
  }

  static displayLocalOrRemoteMediumPhoto( photo: RealmPhoto ) {
    return (
      Photo.preferredLocalPhotoUri( photo )
      || Photo.displayMediumPhoto( photo?.url )
      || Photo.getLocalPhotoUri( photo?.localFilePath )
    );
  }

  static displayLocalOrRemoteSquarePhoto( photo: RealmPhoto ) {
    return (
      Photo.preferredLocalPhotoUri( photo )
      || photo?.url
      || Photo.getLocalPhotoUri( photo?.localFilePath )
    );
  }

  static displayCropSourcePhoto( photo: RealmPhoto ) {
    return (
      Photo.getLocalPhotoUri( photo?.localFilePath )
      || Photo.displayLargePhoto( photo?.url )
    );
  }

  static displayCropEditorSourcePhoto( photo: RealmPhoto ) {
    return (
      cropOriginalUriFromPath( photo?.cropOriginalLocalFilePath )
      || Photo.displayCropSourcePhoto( photo )
    );
  }

  static savedNormalizedCrop( photo?: RealmPhoto ): NormalizedCrop | null {
    return savedNormalizedCrop( photo ?? {} );
  }

  static async preserveCropOriginal(
    sourceUri: string,
    photo?: RealmPhoto,
  ): Promise<string> {
    return preserveCropOriginalPath(
      sourceUri,
      photo?.cropOriginalLocalFilePath,
    );
  }

  static cropMetadataFromNormalizedCrop( crop: NormalizedCrop ) {
    return normalizedCropToStorage( crop );
  }

  static async deletePhotoFromDeviceStorage( path: string ) {
    const localPhoto = Photo.getLocalPhotoUri( path );
    // localPhoto is null for rotatedOriginalPhotos paths; fall back to the
    // original path so those files are also cleaned up
    await unlink( localPhoto || path );
  }

  static schema = {
    name: "Photo",
    embedded: true,
    properties: {
      // datetime the photo was created on the device
      _created_at: "date?",
      // datetime the photo was last synced with the server
      _synced_at: "date?",
      // datetime the photo was updated on the device (i.e. edited locally)
      _updated_at: "date?",
      id: "int?",
      attribution: "string?",
      license_code: { type: "string", mapTo: "licenseCode", optional: true },
      url: "string?",
      localFilePath: "string?",
      cropOriginalLocalFilePath: "string?",
      cropX: "double?",
      cropY: "double?",
      cropW: "double?",
      cropH: "double?",
      hidden: "bool?",
    },
  };

  // An unpleasant hack around another unpleasant hack, i.e. when we "need" to
  // convert Realm objects to JSON and we apparently lose attributions
  // defined with mapTo
  toJSON( ) {
    const json = super.toJSON( );
    return {
      ...json,
      licenseCode: json.license_code,
    };
  }
}

export default Photo;
