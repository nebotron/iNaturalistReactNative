import { Realm } from "@realm/react";
import {
  OBSERVATION_FIELD_VALUE_FIELDS,
  PROJECT_OBSERVATION_FIELDS,
  PROJECT_SUMMARY_FIELDS,
} from "api/fields";
import { formatDateStringFromTimestamp, getNowISO } from "sharedHelpers/dateAndTime";
import { firstDevicePhotoLocation } from "sharedHelpers/devicePhotoLocation";
import { recordUploadedDevicePhotoUrisFromObservation } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { log } from "sharedHelpers/logger";
import readExifFromMultiplePhotos from "sharedHelpers/parseExif";
import { privacyZoneGeoprivacy } from "sharedHelpers/privacyZone";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import * as uuid from "uuid";

import Application from "./Application";
import Comment from "./Comment";
import Identification from "./Identification";
import ObservationFieldValue from "./ObservationFieldValue";
import ObservationPhoto from "./ObservationPhoto";
import ObservationSound from "./ObservationSound";
import ProjectObservation from "./ProjectObservation";
import Taxon from "./Taxon";
import User from "./User";
import Vote from "./Vote";

export const GEOPRIVACY_OPEN = "open";
export const GEOPRIVACY_OBSCURED = "obscured";
export const GEOPRIVACY_PRIVATE = "private";

const logger = log.extend( "index.js" );

export const UNSYNCED_FILTER
  = "_synced_at == null || _synced_at <= _updated_at"
  + " || ANY observationPhotos._synced_at == null"
  + " || ANY observationSounds._synced_at == null"
  + " || ANY projectObservations._synced_at == null"
  + " || ANY observationFieldValues._synced_at == null";

// The photo library reports every asset's creation date, but a photo whose
// metadata was stripped (a screenshot, a download, anything that arrived
// through a messaging app) carries no EXIF date, and the observation was
// imported with no date at all. That also silently cost it the tracked-location
// auto-fill, which needs a timestamp to match a recorded fix against — and the
// photos with no EXIF date are exactly the ones with no EXIF GPS either, so the
// import that most needed a tracked location was the one that never got one.
const galleryPhotosTimestamp = photos => {
  for ( const photo of photos || [] ) {
    const timestamp = Number( photo?.image?.timestamp );
    if ( Number.isFinite( timestamp ) && timestamp > 0 ) {
      // CameraRoll reports seconds; tolerate a milliseconds value rather than
      // dating the observation to the year 5138.
      return formatDateStringFromTimestamp( timestamp > 1e11
        ? Math.round( timestamp / 1000 )
        : timestamp );
    }
  }
  return null;
};

// noting that methods like .toJSON( ) are only accessible when the model
// class is extended with Realm.Object per this issue:
// https://github.com/realm/realm-js/issues/3600#issuecomment-785828614
class Observation extends Realm.Object {
  static FIELDS = {
    application: Application.APPLICATION_FIELDS,
    captive: true,
    comments: Comment.COMMENT_FIELDS,
    created_at: true,
    description: true,
    geojson: true,
    geoprivacy: true,
    id: true,
    identifications: Identification.ID_FIELDS,
    latitude: true,
    license_code: true,
    location: true,
    longitude: true,
    obscured: true,
    observation_photos: ObservationPhoto.OBSERVATION_PHOTOS_FIELDS,
    observed_on: true,
    place_guess: true,
    quality_grade: true,
    observation_sounds: ObservationSound.OBSERVATION_SOUNDS_FIELDS,
    observed_time_zone: true,
    taxon: Taxon.TAXON_FIELDS,
    taxon_geoprivacy: true,
    time_observed_at: true,
    user: User && {
      ...User.FIELDS,
      preferences: {
        prefers_community_taxa: true,
      },
    },
    updated_at: true,
    viewer_trusted_by_observer: true,
    reviewed_by: true,
    votes: Vote.VOTE_FIELDS,
    private_geojson: true,
    private_location: true,
    private_place_guess: true,
    project_ids: true,
    project_observations: PROJECT_OBSERVATION_FIELDS,
    ofvs: OBSERVATION_FIELD_VALUE_FIELDS,
    non_traditional_projects: {
      project: PROJECT_SUMMARY_FIELDS,
    },
    positional_accuracy: true,
    preferences: {
      prefers_community_taxon: true,
    },
  };

  static DEFAULT_MODE_LIST_FIELDS = {
    created_at: true,
    id: true, // needed to get next page in infinite queries
    observation_photos: {
      id: true,
      photo: {
        id: true,
        url: true,
      },
      uuid: true,
    },
    observation_sounds: {
      uuid: true,
    },
    quality_grade: true,
    taxon: {
      id: true,
      is_active: true,
      name: true,
      preferred_common_name: true,
      // rank and rank_level are needed to italicize scientific names
      rank: true,
      rank_level: true,
    },
    time_observed_at: true,
    user: {
      id: true,
    },
    uuid: true,
  };

  static ADVANCED_MODE_LIST_FIELDS = {
    ...Observation.DEFAULT_MODE_LIST_FIELDS,
    identifications: {
      uuid: true,
      current: true,
      taxon: {
        id: true,
        is_active: true,
      },
      user: {
        id: true,
      },
    },
    reviewed_by: true,
    comments: {
      uuid: true,
    },
    geoprivacy: true,
    id: true,
    latitude: true,
    longitude: true,
    obscured: true,
    observed_on: true,
    observed_time_zone: true,
    place_guess: true,
    private_geojson: true,
    private_place_guess: true,
    taxon_geoprivacy: true,
    project_observations: PROJECT_OBSERVATION_FIELDS,
    ofvs: OBSERVATION_FIELD_VALUE_FIELDS,
    votes: Vote.VOTE_FIELDS,
  };

  static async new( obs ) {
    return {
      ...obs,
      captive_flag: false,
      geoprivacy: GEOPRIVACY_OPEN,
      owners_identification_from_vision: false,
      observed_on: obs?.observed_on,
      observed_on_string: obs
        ? obs?.observed_on_string
        : getNowISO( ),
      quality_grade: "needs_id",
      needs_sync: true,
      uuid: uuid.v4( ),
    };
  }

  static async createObsWithSoundPath( soundPath ) {
    const observation = await Observation.new( );
    const sound = await ObservationSound.new( soundPath );
    observation.observationSounds = [sound];
    return observation;
  }

  static upsertRemoteObservations( remoteObservations, realm, options = {} ) {
    if ( !remoteObservations ) return;
    if ( remoteObservations.length === 0 ) return;
    const obsToUpsert = options.force
      ? remoteObservations
      : remoteObservations.filter( obs => !Observation.isUnsyncedObservation( realm, obs ) );
    // const msg = obsToUpsert.map( remoteObservation => {
    //   const obsPhotoUUIDs = remoteObservation.observation_photos?.map( op => op.uuid );
    //   return `obs ${remoteObservation.uuid}, ops: ${obsPhotoUUIDs}`;
    // } );
    // Trying to debug disappearing photos
    safeRealmWrite( realm, ( ) => {
      obsToUpsert.forEach( remoteObservation => {
        const obsMappedForRealm = Observation.mapApiToRealm( remoteObservation, realm );
        realm.create(
          "Observation",
          obsMappedForRealm,
          "modified",
        );
      } );
    }, "upserting remote observations in Observation" );
  }

  static mapApiToRealm( obs, realm = null ) {
    if ( !obs ) return obs;
    const existingObs = realm?.objectForPrimaryKey( "Observation", obs.uuid );
    const taxon = obs.taxon
      ? Taxon.mapApiToRealm( obs.taxon, realm )
      : null;

    const observationFieldValues = (
      obs.ofvs || []
    ).map( ofv => {
      const mappedOfv = ObservationFieldValue.mapApiToRealm( ofv );
      const existingOfv = existingObs?.observationFieldValues?.find(
        eOfv => eOfv.uuid === ofv.uuid,
      );
      if ( !existingOfv ) {
        mappedOfv._created_at = new Date( );
      }
      return mappedOfv;
    } );

    const observationPhotos = (
      obs.observation_photos || obs.observationPhotos || []
    ).map( obsPhoto => {
      const mappedObsPhoto = ObservationPhoto.mapApiToRealm( obsPhoto, realm );
      const existingObsPhoto = existingObs?.observationPhotos?.find(
        op => op.uuid === obsPhoto.uuid,
      );
      if ( !existingObsPhoto ) {
        mappedObsPhoto._created_at = new Date( );
        mappedObsPhoto.photo._created_at = new Date( );
      } else if ( existingObsPhoto.originalDevicePhotoUri ) {
        // ObservationPhoto is an embedded object, so it has no identity of its
        // own and "modified" can't merge into it: assigning this list replaces
        // the stored one wholesale, and anything the API doesn't return is
        // gone. originalDevicePhotoUri is local-only and never comes back from
        // the API, so without this it survived only until the observation was
        // next downloaded — after which the link between an uploaded
        // observation and the photo still sitting in the device library was
        // lost for good. Delete Unfaved then had nothing left but an exact
        // same-second capture-time match, which is why the photos it stopped
        // finding were the older ones.
        mappedObsPhoto.originalDevicePhotoUri = existingObsPhoto.originalDevicePhotoUri;
      }
      return mappedObsPhoto;
    } );

    const observationSounds = (
      obs.observation_sounds || obs.observationSounds || []
    ).map( obsSound => {
      const mappedObsSound = ObservationSound.mapApiToRealm( obsSound, realm );
      const existingObsSound = existingObs?.observationSounds?.find(
        os => os.uuid === obsSound.uuid,
      );
      if ( !existingObsSound ) {
        mappedObsSound._created_at = new Date( );
        mappedObsSound.sound._created_at = new Date( );
      }
      return mappedObsSound;
    } );

    const projectObservations = ( obs.project_observations || [] ).map( apiPo => {
      const mappedPo = ProjectObservation.mapApiToRealm( apiPo );
      const existingPo = existingObs?.projectObservations?.find(
        ePo => ePo.uuid === apiPo.uuid,
      );
      if ( !existingPo ) {
        mappedPo._created_at = new Date( );
      }
      return mappedPo;
    } );

    const localObs = {
      ...obs,
      _synced_at: new Date( ),
      // obs detail on web says geojson coords are preferred over lat/long
      // https://github.com/inaturalist/inaturalist/blob/df6572008f60845b8ef5972a92a9afbde6f67829/app/webpack/observations/show/ducks/observation.js#L145
      // ...but list requests don't ask for geojson, and without the fallback
      // these keys would overwrite the coordinates the response did include
      // with undefined, leaving synced observations with no location at all.
      latitude: ( obs.geojson && obs.geojson.coordinates && obs.geojson.coordinates[1] )
        ?? obs.latitude,
      longitude: ( obs.geojson && obs.geojson.coordinates && obs.geojson.coordinates[0] )
        ?? obs.longitude,
      privateLatitude: obs.private_geojson && obs.private_geojson.coordinates
                      && obs.private_geojson.coordinates[1],
      privateLongitude: obs.private_geojson && obs.private_geojson.coordinates
                      && obs.private_geojson.coordinates[0],
      observationFieldValues,
      observationPhotos,
      observationSounds,
      prefers_community_taxon: obs.preferences?.prefers_community_taxon,
      projectObservations,
      taxon,
    };

    if ( localObs.user ) {
      localObs.user.prefers_community_taxa = (
        localObs.user.prefers_community_taxa
        || localObs.user.preferences?.prefers_community_taxa
      );
    }

    if ( !existingObs ) {
      localObs._created_at = new Date( localObs.created_at );
      if ( isNaN( localObs._created_at ) ) {
        localObs._created_at = new Date( );
      }
    }

    return localObs;
  }

  static prepareEmbedForLocalSave( embed, now, existingEmbed ) {
    if ( !embed ) {
      return embed;
    }

    const { _pendingRemoval, ...restWithoutPendingRemoval } = embed;

    if ( _pendingRemoval || embed._pending_deletion ) {
      return {
        ...restWithoutPendingRemoval,
        _pending_deletion: true,
        _updated_at: now,
      };
    }

    const isNew = !existingEmbed;
    const wasReactivated = existingEmbed?._pending_deletion && !embed._pending_deletion;
    if ( isNew || wasReactivated ) {
      return {
        ...embed,
        _synced_at: null,
        _updated_at: now,
      };
    }

    return embed;
  }

  static prepareEmbedsForLocalSave( embeds, now, existingEmbeds ) {
    return ( embeds || [] ).map( embed => {
      const existingEmbed = existingEmbeds?.find( e => e.uuid === embed.uuid );
      return Observation.prepareEmbedForLocalSave( embed, now, existingEmbed );
    } );
  }

  static async saveLocalObservationForUpload( obs, realm ) {
    // make sure local observations have user details for ObsDetail
    const currentUser = User.currentUser( realm );
    if ( currentUser ) {
      obs.user = currentUser;
    }

    const timestamps = {
      _updated_at: new Date( ),
    };

    const existingObservation = realm.objectForPrimaryKey( "Observation", obs.uuid );

    if ( !existingObservation ) {
      timestamps._created_at = new Date( );
      timestamps._synced_at = null;
    }

    const addTimestampsToEvidence = ( evidence, existingEvidence ) => ( evidence
      ? evidence.map( record => {
        // Don't bump _updated_at on already-synced evidence in existing observations:
        // their _synced_at timestamp already correctly reflects that they are up to date.
        // Bumping _updated_at would cause needsSync() to return true and trigger an
        // unnecessary (or broken) re-upload of the photo file.
        if ( existingObservation && record._synced_at ) {
          // Exception: if position changed, bump _updated_at so the new order syncs.
          const existingRecord = existingEvidence?.find( r => r.uuid === record.uuid );
          if ( existingRecord && existingRecord.position !== record.position ) {
            return { ...record, ...timestamps };
          }
          return record;
        }
        return { ...record, ...timestamps };
      } )
      : evidence );

    const taxon = obs.taxon || null;
    const observationPhotos = addTimestampsToEvidence(
      obs.observationPhotos,
      existingObservation?.observationPhotos,
    );
    const observationSounds = addTimestampsToEvidence( obs.observationSounds );
    const projectObservations = Observation.prepareEmbedsForLocalSave(
      obs.projectObservations,
      timestamps._updated_at,
      existingObservation?.projectObservations,
    );
    const observationFieldValues = Observation.prepareEmbedsForLocalSave(
      obs.observationFieldValues,
      timestamps._updated_at,
      existingObservation?.observationFieldValues,
    );

    const obsToSave = {
      // just ...obs causes problems when obs is a realm object
      // ...obs.toJSON( ),
      ...obs,
      ...timestamps,
      needs_sync: true,
      taxon,
      observationPhotos,
      observationSounds,
      projectObservations,
      observationFieldValues,
    };

    // A save that clears a previously-set location is never something the user
    // asked for — nothing in the app removes an observation's coordinates — so
    // it always means the caller passed in a stale in-memory copy captured
    // before a background tracked-location fill completed. Keep the location
    // that's already on the record rather than wiping it and relying on the
    // tracked-location pass to put it back on the next save.
    if (
      existingObservation?.latitude != null
      && existingObservation?.longitude != null
      && ( obsToSave.latitude == null || obsToSave.longitude == null )
    ) {
      logger.warn(
        `Observation ${obs.uuid} save would have cleared a previously-set location; `
        + `keeping ${existingObservation.latitude},${existingObservation.longitude}`,
      );
      obsToSave.latitude = existingObservation.latitude;
      obsToSave.longitude = existingObservation.longitude;
      obsToSave.positional_accuracy ??= existingObservation.positional_accuracy;
      obsToSave.place_guess ??= existingObservation.place_guess;
    }

    // Every local save runs through here, so this is where the user's privacy
    // zone gets enforced: anything saved inside it is obscured before it can
    // be uploaded. Runs after the location is restored above so a stale save
    // can't slip a zone location past the check by arriving without one.
    const zoneGeoprivacy = privacyZoneGeoprivacy( obsToSave );
    if ( zoneGeoprivacy ) {
      obsToSave.geoprivacy = zoneGeoprivacy;
      logger.info( `Obscuring observation ${obs.uuid} because it is inside the privacy zone` );
    }

    safeRealmWrite( realm, ( ) => {
      // using 'modified' here for the case where a new observation has the same Taxon
      // as a previous observation; otherwise, realm will error out
      // also using modified for updating observations which were already saved locally
      realm.create( "Observation", obsToSave, "modified" );
    }, "saving local observation for upload in Observation" );
    const savedObservation = realm.objectForPrimaryKey( "Observation", obs.uuid );
    // Saving is what makes the device photos "saved" as far as the photo
    // gallery's Hide Saved toggle is concerned, so index them now rather than
    // waiting for upload. The index outlives the observation, so the photos
    // stay hidden even if it's later deleted.
    if ( savedObservation ) {
      recordUploadedDevicePhotoUrisFromObservation( realm, savedObservation );
    }
    return savedObservation;
  }

  static mapObservationForUpload( obs ) {
    return {
      captive_flag: obs.captive_flag,
      description: obs.description,
      geoprivacy: obs.geoprivacy,
      latitude: obs.latitude,
      longitude: obs.longitude,
      observed_on_string: obs.observed_on_string,
      owners_identification_from_vision: obs.owners_identification_from_vision,
      place_guess: obs.place_guess,
      positional_accuracy: obs.positional_accuracy,
      species_guess: obs.species_guess,
      taxon_id: obs.taxon && obs.taxon.id,
      uuid: obs.uuid,
    };
  }

  static mapTaxonForMyObs( taxon ) {
    return {
      id: taxon.id,
      name: taxon.name,
      preferred_common_name: taxon.preferred_common_name,
      rank: taxon.rank,
      rank_level: taxon.rank_level,
      iconic_taxon_name: taxon.iconic_taxon_name,
    };
  }

  static mapObservationForMyObsDefaultMode( obs ) {
    return {
      uuid: obs.uuid,
      id: obs.id,
      observationPhotos: obs.observationPhotos.length > 0
        ? obs.observationPhotos
          .map( op => ObservationPhoto.mapObservationPhotoForMyObsDefaultMode( op ) )
        : [],
      observationSounds: obs.observationSounds.length > 0
        ? obs.observationSounds
          .map( os => ObservationSound.mapObservationSoundForMyObsDefaultMode( os ) )
        : [],
      quality_grade: obs.quality_grade,
      taxon: obs.taxon
        ? Observation.mapTaxonForMyObs( obs.taxon )
        : null,
      comments_viewed: obs.comments_viewed,
      identifications_viewed: obs.identifications_viewed,
      missing_coords: typeof obs.missingCoords === "function"
        ? obs.missingCoords( )
        : undefined,
      missing_basics: typeof obs.missingBasics === "function"
        ? obs.missingBasics( )
        : undefined,
      needs_sync: typeof obs.needsSync === "function"
        ? obs.needsSync( )
        : obs.needs_sync,
      votes: obs.votes?.length > 0
        ? Array.from( obs.votes ).map( v => ( {
          id: v.id,
          user_id: v.user_id,
          vote_flag: v.vote_flag,
          vote_scope: v.vote_scope,
        } ) )
        : [],
    };
  }

  static mapObservationForMyObsAdvancedMode( obs ) {
    return {
      ...Observation.mapObservationForMyObsDefaultMode( obs ),
      comments: obs.comments.length > 0
        ? obs.comments
          .map( c => Comment.mapCommentForMyObsAdvancedMode( c ) )
        : [],
      geoprivacy: obs.geoprivacy,
      identifications: obs.identifications.length > 0
        ? obs.identifications
          .map( id => Identification.mapIdentificationForMyObsAdvancedMode( id ) )
        : [],
      latitude: obs.latitude,
      longitude: obs.longitude,
      obscured: obs.obscured,
      observed_on: obs.observed_on,
      observed_on_string: obs.observed_on_string,
      observed_time_zone: obs.observed_time_zone,
      place_guess: obs.place_guess,
      positional_accuracy: obs.positional_accuracy,
      privateLatitude: obs.privateLatitude,
      privateLongitude: obs.privateLongitude,
      taxon_geoprivacy: obs.taxon_geoprivacy,
      time_observed_at: obs.time_observed_at,
    };
  }

  static projectUri = obs => {
    const photo = obs?.observation_photos?.[0];
    if ( !photo ) { return null; }
    if ( !photo.photo ) { return null; }
    if ( !photo.photo.url ) { return null; }

    return { uri: obs.observation_photos[0].photo.url };
  };

  static filterUnsyncedObservations = realm => {
    // we sort unsynced observations here to make sure observations
    // with an older _created_at date get uploaded first
    const unsyncedObs = realm.objects( "Observation" )
      .filtered( UNSYNCED_FILTER )
      .sorted( "_created_at", true );
    return unsyncedObs;
  };

  static isUnsyncedObservation = ( realm, obs ) => {
    const obsList = Observation.filterUnsyncedObservations( realm );
    const unsyncedObs = obsList.filtered( `uuid == "${obs.uuid}"` );
    return unsyncedObs.length > 0;
  };

  static createObservationFromGalleryPhotos = async photos => {
    // Crops are baked before the import creates observations, so image.uri is
    // usually a re-encoded JPEG by the time we get here. Read the EXIF off the
    // untouched original the crop was framed against whenever we still have it,
    // rather than depending on the cropper to carry every tag through.
    const photoUris = photos.map(
      photo => photo?.image?.cropOriginalUri || photo?.image?.uri,
    );
    // Reading EXIF is allowed to find nothing — plenty of photos carry no GPS
    // — but it is not allowed to fail silently, so this deliberately doesn't
    // catch. The caller reports which photos couldn't be imported.
    const newObservation = await readExifFromMultiplePhotos( photoUris );
    // What Photos shows for the asset wins over the file's own tags: it is
    // seeded from them and replaced when the user adjusts the location by
    // hand, which never rewrites the file (see devicePhotoLocation.ts).
    const deviceLocation = firstDevicePhotoLocation( photos );
    if ( deviceLocation ) {
      const movedFromExif = newObservation.latitude !== deviceLocation.latitude
        || newObservation.longitude !== deviceLocation.longitude;
      newObservation.latitude = deviceLocation.latitude;
      newObservation.longitude = deviceLocation.longitude;
      if ( movedFromExif ) {
        // GPSHPositioningError described where the camera thought it was, which
        // says nothing about a point the user placed by hand somewhere else.
        delete newObservation.positional_accuracy;
      }
    }
    if ( !newObservation.observed_on_string ) {
      newObservation.observed_on_string = galleryPhotosTimestamp( photos );
    }
    return Observation.new( newObservation );
  };

  // Type of photos is
  // Passed in from PhotoSharing:
  // { image: { uri: string }[]
  static createObservationWithPhotos = async photos => {
    const newLocalObs = await Observation.createObservationFromGalleryPhotos( photos );
    newLocalObs.observationPhotos = await ObservationPhoto
      .createObsPhotosWithPosition( photos, { position: 0 } );
    return newLocalObs;
  };

  static updateObsExifFromPhotos = async (
    photoUris,
    currentObservation,
    deviceLocation = null,
  ) => {
    const updatedObs = currentObservation;

    const unifiedExif = await readExifFromMultiplePhotos( photoUris );
    // What Photos holds for the asset wins over the file's own tags, for the
    // reasons in devicePhotoLocation.ts.
    if ( deviceLocation ) {
      unifiedExif.latitude = deviceLocation.latitude;
      unifiedExif.longitude = deviceLocation.longitude;
    }

    if ( unifiedExif.latitude && !currentObservation.latitude ) {
      updatedObs.latitude = unifiedExif.latitude;
    }
    if ( unifiedExif.longitude && !currentObservation.longitude ) {
      updatedObs.longitude = unifiedExif.longitude;
    }
    if ( unifiedExif.observed_on_string && !currentObservation.observed_on_string ) {
      updatedObs.observed_on_string = unifiedExif.observed_on_string;
    }
    if ( unifiedExif.positional_accuracy && !currentObservation.positional_accuracy ) {
      updatedObs.positional_accuracy = unifiedExif.positional_accuracy;
    }

    return updatedObs;
  };

  static appendObsPhotos = ( obsPhotos, currentObservation ) => {
    const updatedObs = currentObservation;

    // need empty case for when a user creates an observation with no photos,
    // then tries to add photos to observation later
    const currentObservationPhotos = updatedObs?.observationPhotos || [];

    updatedObs.observationPhotos = [...currentObservationPhotos, ...obsPhotos];
    return updatedObs;
  };

  static appendObsSounds = ( obsSounds, currentObservation ) => {
    const updatedObs = currentObservation;

    // need empty case for when a user creates an observation with no sounds,
    // then tries to add sounds to observation later
    const currentObservationSounds = updatedObs?.observationSounds || [];

    updatedObs.observationSounds = [...currentObservationSounds, ...obsSounds];
    return updatedObs;
  };

  static deleteLocalObservation = ( realm, uuidToDelete ) => {
    const observation = realm?.objectForPrimaryKey( "Observation", uuidToDelete );
    if ( observation ) {
      safeRealmWrite( realm, ( ) => {
        realm?.delete( observation );
      }, `deleting local observation ${uuidToDelete} in deleteLocalObservation` );
    }
  };

  static markPendingDeletion( realm, uuidToDelete ) {
    const observation = realm.objectForPrimaryKey( "Observation", uuidToDelete );
    if ( observation ) {
      safeRealmWrite( realm, ( ) => {
        observation._pending_deletion = true;
      } );
    }
  }

  static clearPendingDeletion( realm, uuidToDelete ) {
    const observation = realm.objectForPrimaryKey( "Observation", uuidToDelete );
    if ( observation ) {
      safeRealmWrite( realm, ( ) => {
        observation._pending_deletion = false;
      } );
    }
  }

  static schema = {
    name: "Observation",
    primaryKey: "uuid",
    properties: {
      _pending_deletion: "bool?",
      // datetime the observation was created on the device
      _created_at: "date?",
      // datetime the observation was requested to be deleted
      _deleted_at: "date?",
      // datetime the observation was last synced with the server
      _synced_at: "date?",
      // datetime the observation was updated on the device (i.e. edited locally)
      _updated_at: "date?",
      uuid: "string",
      application: "Application?",
      captive_flag: "bool?",
      comments: "Comment[]",
      // timestamp of when observation was created on the server; not editable
      created_at: { type: "string", mapTo: "createdAt", optional: true },
      description: "string?",
      geoprivacy: "string?",
      id: "int?",
      identifications: "Identification[]",
      latitude: "double?",
      license_code: { type: "string", mapTo: "licenseCode", optional: true },
      longitude: "double?",
      observationFieldValues: "ObservationFieldValue[]",
      observationPhotos: "ObservationPhoto[]",
      observationSounds: "ObservationSound[]",
      // date and/or time submitted to the server when a new obs is uploaded
      observed_on_string: "string?",
      observed_on: "string?",
      observed_time_zone: "string?",
      obscured: "bool?",
      owners_identification_from_vision: "bool?",
      place_guess: { type: "string", mapTo: "placeGuess", optional: true },
      positional_accuracy: "double?",
      prefers_community_taxon: "bool?",
      projectObservations: "ProjectObservation[]",
      quality_grade: { type: "string", mapTo: "qualityGrade", optional: true },
      species_guess: "string?",
      taxon: "Taxon?",
      taxon_geoprivacy: "string?",
      // datetime when the observer observed the organism; user-editable, but
      // only by changing observed_on_string
      time_observed_at: { type: "string", mapTo: "timeObservedAt", optional: true },
      user: "User?",
      updated_at: "date?",
      comments_viewed: "bool?",
      identifications_viewed: { type: "bool", mapTo: "identificationsViewed", optional: true },
      viewer_trusted_by_observer: {
        type: "bool",
        mapTo: "viewerTrustedByObserver",
        optional: true,
      },
      votes: "Vote[]",
      private_place_guess: { type: "string", mapTo: "privatePlaceGuess", optional: true },
      private_location: { type: "string", mapTo: "privateLocation", optional: true },
      privateLatitude: "double?",
      privateLongitude: "double?",
      needs_sync: { type: "bool", default: false, indexed: true },
    },
  };

  needsSync( ) {
    const obsPhotosNeedSync = this.observationPhotos
      .filter( obsPhoto => obsPhoto.needsSync( ) ).length > 0;
    const obsSoundsNeedSync = this.observationSounds
      .filter( obsSound => obsSound.needsSync( ) ).length > 0;
    const projectObsNeedSync = this.projectObservations
      .filter( po => po.needsSync( ) ).length > 0;
    const obsFieldValuesNeedSync = this.observationFieldValues
      .filter( ofv => ofv.needsSync( ) ).length > 0;
    return !this._synced_at
      || this._synced_at <= this._updated_at
      || obsPhotosNeedSync
      || obsSoundsNeedSync
      || projectObsNeedSync
      || obsFieldValuesNeedSync;
  }

  updateNeedsSync() {
    this.needsSync = this.needsSync();
  }

  wasSynced( ) {
    return this._synced_at !== null;
  }

  viewed() {
    return !!( this.comments_viewed && this.identifications_viewed );
  }

  unviewed() {
    return !this.viewed();
  }

  // Faves are the subset of votes for which vote_scope is null
  faves() {
    return this.votes.filter( vote => vote?.vote_scope === null );
  }

  missingCoords() {
    const missingCoords = typeof this.latitude !== "number"
      && typeof this.longitude !== "number"
      && typeof this.privateLatitude !== "number"
      && typeof this.privateLongitude !== "number";
    return missingCoords;
  }

  missingBasics() {
    const missingId = !this.uuid;
    const missingDate = !Date.parse( this.observed_on_string ) && !this.time_observed_at;
    const missingEvidence = ( this.observationPhotos?.length ?? 0 ) === 0
      && ( this.observationSounds?.length ?? 0 ) === 0;
    const missingTaxon = !this.taxon;
    return missingId
      || missingDate
      || this.missingCoords( )
      || missingEvidence
      || missingTaxon;
  }
}

export default Observation;
