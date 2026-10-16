import { fetchSpeciesCounts, searchObservations } from "api/observations";
import type { UserLocation } from "sharedHelpers/fetchCoarseUserLocation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";

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
// scripts/bird_audio/birdnet/README.md). All of it runs offline; with the
// network, species rarely observed nearby are left out too (fetchNearbyTaxa).

const GEO_THRESHOLD = 0.03;
const NON_BIRD_GEO_THRESHOLD = 0.0003;

// Animal classes the model covers.
export const SOUND_TAXON_IDS = [
  3, // birds
  20978, // amphibians
  47158, // insects
  40151, // mammals
  26036, // reptiles
].join( "," );

// iNaturalist observations near the user are finer-grained than the
// geomodel: around Seattle it passes Red Fox, Blue Jay and Clark's Nutcracker,
// which have 0-5 observations within 25 km, and those were 34 of the 109 wrong
// detections users labeled. A species counts as nearby with at least
// NEARBY_MIN_FRACTION of the area's verifiable observations (20 around
// Seattle); that kept the true species for 99.3% of 700 held-out recordings and
// every right detection users labeled. Areas with few observations aren't
// filtered, nor is anything without the network.
const NEARBY_RADIUS_KM = 25;
const NEARBY_MIN_FRACTION = 2e-5;
const NEARBY_MIN_TOTAL = 100000;
const NEARBY_PER_PAGE = 500;
const NEARBY_MAX_PAGES = 4;

// Taxon IDs (with ancestors) common enough near the location, or null to not filter.
export const fetchNearbyTaxa = async ( location: UserLocation ): Promise<Set<number> | null> => {
  const area = {
    lat: location.latitude,
    lng: location.longitude,
    radius: NEARBY_RADIUS_KM,
    verifiable: true,
  };
  const total = ( await searchObservations( { ...area, per_page: 0 } ) )?.total_results;
  if ( !total || total < NEARBY_MIN_TOTAL ) return null;
  const min = total * NEARBY_MIN_FRACTION;
  const ids = new Set<number>( );
  for ( let page = 1; page <= NEARBY_MAX_PAGES; page += 1 ) {
    // eslint-disable-next-line no-await-in-loop
    const p = await fetchSpeciesCounts( {
      ...area, taxon_id: SOUND_TAXON_IDS, per_page: NEARBY_PER_PAGE, page,
    } );
    const results: { count: number; taxon: { id: number; ancestor_ids?: number[] } }[]
      = p?.results;
    if ( !results ) return null;
    results.forEach( r => {
      if ( r.count < min ) return;
      ids.add( r.taxon.id );
      r.taxon.ancestor_ids?.forEach( id => ids.add( id ) );
    } );
    if ( results.length < NEARBY_PER_PAGE || results[results.length - 1].count < min ) return ids;
  }
  return null;
};

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
