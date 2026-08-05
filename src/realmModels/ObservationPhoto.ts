import { Realm } from "@realm/react";
import type { ApiObservationPhoto } from "api/types";
import inatjs, { FileUpload } from "inaturalistjs";
import type { Asset } from "react-native-image-picker";
import type { RealmObservationPhoto, RealmPhoto } from "realmModels/types";
import type { GroupedPhotoCropMetadata } from "sharedHelpers/cropPhotoMetadata";
import {
  getGalleryAssetDevicePhotoUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import * as uuid from "uuid";

import Photo from "./Photo";

class ObservationPhoto extends Realm.Object {
  _created_at?: Date;

  _synced_at?: Date;

  _updated_at?: Date;

  static OBSERVATION_PHOTOS_FIELDS = {
    id: true,
    photo: Photo.PHOTO_FIELDS,
    position: true,
    uuid: true,
  } as const;

  needsSync( ) {
    return !this._synced_at || this._synced_at <= this._updated_at;
  }

  wasSynced( ) {
    return this._synced_at !== null;
  }

  static mapApiToRealm( observationPhoto: ApiObservationPhoto, realm = null ) {
    const localObsPhoto = {
      ...observationPhoto,
      _synced_at: new Date( ),
      photo: Photo.mapApiToRealm( observationPhoto.photo, realm ),
    };
    return localObsPhoto;
  }

  static mapPhotoForUpload( photo: RealmPhoto ) {
    const uri = Photo.getLocalPhotoUri( photo.localFilePath );
    return {
      file: new FileUpload( {
        uri,
        name: uri?.split( "/" ).pop( ),
        type: "image/jpeg",
      } ),
    };
  }

  static needsPhotoReupload( photo?: RealmPhoto ) {
    return Photo.hasLocalEdits( photo );
  }

  static mapPhotoForAttachingToObs(
    observationID: number,
    observationPhoto: RealmObservationPhoto,
  ) {
    return {
      observation_photo: {
        uuid: observationPhoto.uuid,
        observation_id: observationID,
        photo_id: observationPhoto.photo.id,
        position: observationPhoto.position,
      },
    };
  }

  static mapPhotoForUpdating(
    observationID: number,
    observationPhoto: RealmObservationPhoto,
  ) {
    const observationPhotoParams: {
      observation_id: number;
      position?: number;
      photo_id?: number;
    } = {
      observation_id: observationID,
      position: observationPhoto.position,
    };

    // Always point the observation photo at whatever photo id the record
    // carries now. This used to be gated on needsPhotoReupload( photo ), but
    // the re-uploaded photo is marked synced (markRecordUploaded) before this
    // runs, which makes that check false every time -- so the id of the photo
    // just uploaded never reached the server and the observation kept its
    // original photo. That is why a crop made in the observation editor
    // survived locally and vanished once the observation uploaded. When
    // nothing was re-uploaded this is the id the server already has, so
    // sending it changes nothing.
    const { photo } = observationPhoto;
    if ( photo?.id ) {
      observationPhotoParams.photo_id = photo.id;
    }

    return {
      id: observationPhoto.uuid,
      observation_photo: observationPhotoParams,
    };
  }

  // TODO: I don't know how what the type for this is outside of this context,
  // I think it is only called after certain transformations on the Realm result,
  // but it is not important for my current linear ticket so I'll skip typing it more
  static mapObservationPhotoForMyObsDefaultMode( observationPhoto: {
    photo?: {
      url?: string;
      localFilePath?: string;
      _synced_at?: Date;
      _updated_at?: Date;
    };
    uuid?: string;
  } ) {
    return {
      photo: {
        url: observationPhoto?.photo?.url,
        localFilePath: observationPhoto?.photo?.localFilePath,
        // Photo.hasLocalEdits reads these to decide whether the local file is
        // newer than what was uploaded. Dropping them made every photo here
        // look unedited, so an uploaded observation whose photo had been
        // cropped (or otherwise edited) locally showed the remote original
        // instead of the local file -- the crop looked lost as soon as the
        // observation was saved and My Observations drew it again.
        _synced_at: observationPhoto?.photo?._synced_at,
        _updated_at: observationPhoto?.photo?._updated_at,
      },
      uuid: observationPhoto?.uuid,
    };
  }

  static async new(
    uri: string,
    position: number,
    originalDevicePhotoUri?: string | null,
    cropMetadata?: GroupedPhotoCropMetadata,
  ) {
    const photo = await Photo.new( uri, cropMetadata );
    return {
      _created_at: new Date( ),
      _updated_at: new Date( ),
      uuid: uuid.v4( ),
      photo,
      originalPhotoUri: uri,
      originalDevicePhotoUri: originalDevicePhotoUri ?? undefined,
      position,
    };
  }

  static createObsPhotosWithPosition = async (
    photos: string[] | { image: Asset }[],
    { position, local }: { position: number; local: boolean },
  ) => Promise.all(
    photos.map( async ( photo, index ) => {
      const uri = local
        ? photo as string
        : ( photo as { image: Asset } )?.image?.uri;
      const galleryPhoto = photo as {
        image: Asset & GroupedPhotoCropMetadata;
        originalDevicePhotoUri?: string | null;
      };
      const originalDevicePhotoUri = local
        ? null
        : normalizeDevicePhotoUri( galleryPhoto.originalDevicePhotoUri )
          ?? getGalleryAssetDevicePhotoUri( galleryPhoto.image );
      // Carry over any crop framed in the Group Photos grid so the observation
      // photo remembers the crop box, not just the cropped pixels.
      const cropMetadata = local
        ? undefined
        : {
          cropOriginalUri: galleryPhoto.image?.cropOriginalUri,
          crop: galleryPhoto.image?.crop,
        };
      return ObservationPhoto.new(
        uri,
        position + index,
        originalDevicePhotoUri,
        cropMetadata,
      );
    } ),
  );

  // TODO: I don't know how what the type for currentObservation is outside of this context here,
  // in the zustand store slice that is referenced in the two places this function is called
  // there are no types yet as far as I can see. This function is not important for my current
  // linear ticket so I'll skip typing it
  static async deleteRemotePhoto(
    uri: string,
    currentObservation?: { observationPhotos?: { photo: { url?: string }; uuid: string }[] },
  ) {
    const obsPhotoToDelete = currentObservation?.observationPhotos?.find(
      p => p.photo?.url === uri,
    );

    if ( obsPhotoToDelete ) {
      // Removing this require breaks tests, so I am leaving it here
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getJWT } = require( "components/LoginSignUp/AuthenticationService" );
      const apiToken = await getJWT( );
      const options = { api_token: apiToken };
      await inatjs.observation_photos.delete( { id: obsPhotoToDelete.uuid }, options );
    }
  }

  static async deleteLocalPhoto( uri: string ) {
    // delete uri on disk
    await Photo.deletePhotoFromDeviceStorage( uri );
  }

  // TODO: I don't know how what the type for currentObservation is outside of this context here,
  // in the zustand store slice that is referenced in the two places this function is called
  // there are no types yet as far as I can see. This function is not important for my current
  // linear ticket so I'll skip typing it
  static async deletePhoto(
    uri: string,
    currentObservation?: { observationPhotos?: { photo: { url?: string }; uuid: string }[] },
  ) {
    if ( uri.includes( "https://" ) ) {
      await ObservationPhoto.deleteRemotePhoto( uri, currentObservation );
    } else {
      await ObservationPhoto.deleteLocalPhoto( uri );
    }
  }

  // TODO: I don't know how what the type for currentObservation is outside of this context here,
  // in the zustand store slice that is referenced in the two places this function is called
  // there are no types yet as far as I can see. This function is not important for my current
  // linear ticket so I'll skip typing it
  static mapObsPhotoUris(
    observation: {
      observationPhotos?: { photo: RealmPhoto }[];
      observation_photos?: { photo: RealmPhoto }[];
    },
  ) {
    const obsPhotos = observation?.observationPhotos || observation?.observation_photos;
    const obsPhotoUris = ( obsPhotos || [] ).map(
      // Ensure that if this URI is a remote thumbnail that we are resizing
      // a reasonably-sized image for Suggestions and not delivering a handful of
      // upsampled pixels
      obsPhoto => Photo.displayLocalOrRemoteMediumPhoto( obsPhoto.photo ),
    );
    return obsPhotoUris;
  }

  // TODO: I don't know how what the type for currentObservation is outside of this context here,
  // in the zustand store slice that is referenced in the two places this function is called
  // there are no types yet as far as I can see. This function is not important for my current
  // linear ticket so I'll skip typing it
  static mapInnerPhotos(
    observation: {
      observationPhotos?: { photo: object }[];
      observation_photos?: { photo: object }[];
    },
  ) {
    const obsPhotos = observation?.observationPhotos || observation?.observation_photos;
    const innerPhotos = ( obsPhotos || [] ).map(
      obsPhoto => obsPhoto.photo,
    );
    return innerPhotos;
  }

  static schema = {
    name: "ObservationPhoto",
    embedded: true,
    properties: {
      // datetime the obsPhoto was created on the device
      _created_at: "date?",
      // datetime the obsPhoto was last synced with the server
      _synced_at: "date?",
      // datetime the obsPhoto was updated on the device (i.e. edited locally)
      _updated_at: "date?",
      uuid: "string",
      id: "int?",
      originalDevicePhotoUri: "string?",
      photo: "Photo?",
      position: "int?",
      // this creates an inverse relationship so observation photos
      // automatically keep track of which Observation they are assigned to
      assignee: {
        type: "linkingObjects",
        objectType: "Observation",
        property: "observationPhotos",
      },
    },
  };
}

export default ObservationPhoto;
