import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";

import SPECIES from "./audioIdSpecies.json";

// Which species Audio ID reports. The bundled model (see
// scripts/bird_audio/birdnet/build_model.py) has one output per species in
// audioIdSpecies.json: [scientific name, common name, iNaturalist taxon ID,
// geomodel index or -1]. When the user's location is known, birds the BirdNET
// geomodel puts below GEO_THRESHOLD at their place and week are left out. All
// of it runs offline.

const GEO_THRESHOLD = 0.03;

export interface AudioIdSpecies { name: string; commonName: string; taxonId: number }
export interface AudioIdSetup {
  outputs: number[];
  species: AudioIdSpecies[]; // one per output, same order
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
  ( SPECIES as [string, string, number, number][] ).forEach(
    ( [name, commonName, taxonId, geoIndex], output ) => {
      if ( occurrence && geoIndex >= 0 && occurrence[geoIndex] < GEO_THRESHOLD ) return;
      outputs.push( output );
      species.push( { name, commonName, taxonId } );
    },
  );
  return { outputs, species, located: !!location };
};
