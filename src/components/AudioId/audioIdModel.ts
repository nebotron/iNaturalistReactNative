import type { UserLocation } from "sharedHelpers/fetchCoarseUserLocation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import { getTunable } from "sharedHelpers/tunableParams";

import SPECIES from "./audioIdSpecies.json";

// Which species Audio ID reports. The bundled model (see
// scripts/bird_audio/birdnet/build_model.py) has one output per species in
// audioIdSpecies.json: [scientific name, common name, iNaturalist taxon ID,
// geomodel index or -1, 1 if a bird]. When the user's location is known,
// species the BirdNET geomodel puts below a threshold at their place and week
// are left out. Other taxa score lower than birds, so they get a much lower
// threshold that only drops species from the wrong region. Their scores are
// not weighted by the geomodel: that tripled Harbor Seal odds near Puget Sound,
// and every non-bird users labeled was wrong (see
// scripts/bird_audio/birdnet/README.md). All of it runs offline.

const GEO_THRESHOLD = getTunable( "audioIdBirdGeoThreshold" );
const NON_BIRD_GEO_THRESHOLD = getTunable( "audioIdNonBirdGeoThreshold" );

export interface AudioIdSpecies { name: string; commonName: string; taxonId: number }
export interface AudioIdSetup {
  outputs: number[];
  species: AudioIdSpecies[]; // one per output, same order
  occurrence: number[]; // per output, geomodel score at the user's place, or -1
  located: boolean;
  location: UserLocation | null;
}

// BirdNET's 48-week year: four weeks per month.
const birdnetWeek = ( d: Date ) => d.getMonth( ) * 4
  + Math.min( 4, Math.floor( ( d.getDate( ) - 1 ) / 7 ) + 1 );

export const prepareAudioId = async (
  geo: ( lat: number, lng: number, week: number ) => Promise<number[]>,
): Promise<AudioIdSetup> => {
  const location = await fetchCoarseUserLocation( );
  const occurrence = location
    ? await geo( location.latitude, location.longitude, birdnetWeek( new Date( ) ) )
    : null;
  const outputs: number[] = [];
  const species: AudioIdSpecies[] = [];
  const occ: number[] = [];
  ( SPECIES as [string, string, number, number, number][] ).forEach(
    ( [name, commonName, taxonId, geoIndex, bird], output ) => {
      if ( occurrence && geoIndex >= 0 && occurrence[geoIndex]
        < ( bird
          ? GEO_THRESHOLD
          : NON_BIRD_GEO_THRESHOLD ) ) return;
      outputs.push( output );
      species.push( { name, commonName, taxonId } );
      occ.push( occurrence && geoIndex >= 0
        ? occurrence[geoIndex]
        : -1 );
    },
  );
  return {
    outputs, species, occurrence: occ, located: !!location, location,
  };
};
