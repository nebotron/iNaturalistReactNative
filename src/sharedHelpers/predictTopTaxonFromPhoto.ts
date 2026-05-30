import orderBy from "lodash/orderBy";
import type Realm from "realm";
import ObservationPhoto from "realmModels/ObservationPhoto";
import Taxon from "realmModels/Taxon";
import type { RealmObservationPojo } from "realmModels/types";
import { log } from "sharedHelpers/logger";
import { predictOffline } from "sharedHooks/useSuggestions/useOfflineSuggestions";

const logger = log.extend( "predictTopTaxonFromPhoto" );

const AUTO_ID_CONFIDENCE_THRESHOLD = 90;

const isSpeciesLevelTaxon = ( rankLevel: number ) => (
  rankLevel <= Taxon.SPECIES_LEVEL && rankLevel < Taxon.STATEOFMATTER_LEVEL
);

export interface VisionTaxon {
  id: number;
  name: string;
  rank_level: number;
  iconic_taxon_name?: string;
}

interface PredictTopTaxonOptions {
  latitude?: number;
  longitude?: number;
  photoUri: string;
  realm: Realm;
}

const hasKnownLocation = (
  latitude?: number,
  longitude?: number,
): latitude is number => typeof latitude === "number" && typeof longitude === "number";

export const predictTopTaxonFromPhoto = async (
  options: PredictTopTaxonOptions,
): Promise<VisionTaxon | null> => {
  const {
    latitude, longitude, photoUri, realm,
  } = options;
  if ( !photoUri || !hasKnownLocation( latitude, longitude ) ) {
    return null;
  }

  try {
    const result = await predictOffline( {
      latitude,
      longitude,
      photoUri,
      realm,
    } );
    if ( !result?.results?.length ) {
      return null;
    }

    const topResult = orderBy( result.results, "combined_score", "desc" )[0];
    if (
      !topResult
      || topResult.combined_score < AUTO_ID_CONFIDENCE_THRESHOLD
    ) {
      return null;
    }

    const { taxon } = topResult;
    if ( !taxon || !isSpeciesLevelTaxon( taxon.rank_level ) ) {
      return null;
    }

    return taxon;
  } catch ( error ) {
    logger.error( "Error predicting top taxon from photo", error );
    return null;
  }
};

export const applyVisionTaxonToObservation = (
  observation: RealmObservationPojo,
  taxon: VisionTaxon | null | undefined,
): RealmObservationPojo => {
  if ( !taxon || !isSpeciesLevelTaxon( taxon.rank_level ) ) {
    return observation;
  }

  observation.taxon = taxon;
  observation.owners_identification_from_vision = true;
  return observation;
};

export const populateObservationTaxonFromPhoto = async (
  observation: RealmObservationPojo,
  photoUri: string,
  realm: Realm,
): Promise<RealmObservationPojo> => {
  const taxon = await predictTopTaxonFromPhoto( {
    photoUri,
    latitude: observation.latitude ?? undefined,
    longitude: observation.longitude ?? undefined,
    realm,
  } );
  return applyVisionTaxonToObservation( observation, taxon );
};

export const populateObservationTaxonFromFirstPhoto = async (
  observation: RealmObservationPojo,
  realm: Realm,
): Promise<RealmObservationPojo> => {
  const photoUri = ObservationPhoto.mapObsPhotoUris( observation )[0];
  if ( !photoUri ) {
    return observation;
  }

  return populateObservationTaxonFromPhoto( observation, photoUri, realm );
};
