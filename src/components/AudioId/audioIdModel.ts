import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";

import SPECIES from "./audioIdSpecies.json";

// Which species Audio ID reports. The bundled model (see
// scripts/bird_audio/birdnet/build_model.py) has one output per species in
// audioIdSpecies.json: [scientific name, common name, iNaturalist taxon ID,
// geomodel index or -1, 1 if a bird]. When the user's location is known,
// species the BirdNET geomodel puts below a threshold at their place and week
// are left out. Other taxa score lower than birds, so they get a much lower
// threshold that only drops species from the wrong region, and their audio
// odds are then weighted by (geomodel score / NON_BIRD_GEO_REF) ^ NON_BIRD_GEO_WEIGHT,
// which raised their recall about 2.5 points for the same wrong species; it
// didn't help birds (see scripts/bird_audio/birdnet/README.md). All of it runs offline.

const GEO_THRESHOLD = 0.03;
const NON_BIRD_GEO_THRESHOLD = 0.0003;
const NON_BIRD_GEO_REF = 0.037;
const NON_BIRD_GEO_WEIGHT = 0.4;

export interface AudioIdSpecies { name: string; commonName: string; taxonId: number }
export interface AudioIdSetup {
  outputs: number[];
  species: AudioIdSpecies[]; // one per output, same order
  odds: number[]; // per output, multiplies the model's odds (see fuseScore)
  occurrence: number[]; // per output, geomodel score at the user's place, or -1
  located: boolean;
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
  const odds: number[] = [];
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
      odds.push( occurrence && geoIndex >= 0 && !bird
        ? ( occurrence[geoIndex] / NON_BIRD_GEO_REF ) ** NON_BIRD_GEO_WEIGHT
        : 1 );
    },
  );
  return {
    outputs, species, odds, occurrence: occ, located: !!location,
  };
};

// The model's probability with its odds multiplied by k.
export const fuseScore = ( s: number, k: number ) => ( s * k ) / ( 1 + s * ( k - 1 ) );
