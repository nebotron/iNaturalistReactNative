import type { UserLocation } from "sharedHelpers/fetchCoarseUserLocation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import { getTunable } from "sharedHelpers/tunableParams";

import SPECIES from "./audioIdSpecies.json";
import SPLITS from "./audioIdSplits.json";

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
//
// BirdNET predates some of iNaturalist's splits, so a BirdNET species can
// cover several iNaturalist species (Marsh Wren is now Eastern and Western
// Marsh Wren). audioIdSplits.json (build_splits.py) lists them with points
// where each is observed; a detection gets the one observed nearest the user,
// or the taxon they share (e.g. the genus) without a location or where more
// than one is observed nearby.

const GEO_THRESHOLD = getTunable( "audioIdBirdGeoThreshold" );
const NON_BIRD_GEO_THRESHOLD = getTunable( "audioIdNonBirdGeoThreshold" );

export interface AudioIdSpecies {
  name: string; commonName: string; taxonId: number; bird?: boolean;
  // BirdNET's name for the species, when the taxon was picked for a split one
  modelName?: string;
}

// [taxon ID, scientific name, English common name]
type SplitTaxon = [number, string, string];
interface Split {
  shared: SplitTaxon;
  // with latitude, longitude pairs in half degrees where it's observed
  taxa: [number, string, string, number[]][];
}

// Within this of the user, a candidate counts as observed nearby
const NEARBY_KM = 75;
const EARTH_KM = 6371;
const RAD = Math.PI / 180;

const unitVector = ( latitude: number, longitude: number ) => [
  Math.cos( latitude * RAD ) * Math.cos( longitude * RAD ),
  Math.cos( latitude * RAD ) * Math.sin( longitude * RAD ),
  Math.sin( latitude * RAD ),
];

// Each candidate's points as unit vectors, made the first time a species is
// looked up, so the search for the nearest is a dot product per point. Points
// are on a half-degree grid, so their sines and cosines come from a table.
let gridTrig: { sin: Float64Array; cos: Float64Array } | null = null;
const vectorCache: Record<string, Float64Array[]> = {};
const candidateVectors = ( name: string, split: Split ) => {
  if ( !gridTrig ) {
    gridTrig = { sin: new Float64Array( 721 ), cos: new Float64Array( 721 ) };
    for ( let h = -360; h <= 360; h += 1 ) {
      gridTrig.sin[h + 360] = Math.sin( ( h / 2 ) * RAD );
      gridTrig.cos[h + 360] = Math.cos( ( h / 2 ) * RAD );
    }
  }
  const { sin, cos } = gridTrig;
  vectorCache[name] ||= split.taxa.map( ( [, , , points] ) => {
    const v = new Float64Array( ( points.length / 2 ) * 3 );
    for ( let i = 0, j = 0; i < points.length; i += 2, j += 3 ) {
      const lat = points[i] + 360;
      const lng = points[i + 1] + 360;
      v[j] = cos[lat] * cos[lng];
      v[j + 1] = cos[lat] * sin[lng];
      v[j + 2] = sin[lat];
    }
    return v;
  } );
  return vectorCache[name];
};

// The iNaturalist taxon for BirdNET's species `name` at `location`, or null
// if iNaturalist hasn't split it. Offline; run once per Audio ID session.
export const splitTaxon = (
  name: string,
  location: { latitude: number; longitude: number } | null,
): SplitTaxon | null => {
  const split = ( SPLITS as Record<string, Split> )[name];
  if ( !split ) return null;
  if ( !location ) return split.shared;
  const [x, y, z] = unitVector( location.latitude, location.longitude );
  // The nearest point of each candidate has the largest dot product
  const nearest = candidateVectors( name, split ).map( ( v, c ) => {
    let dot = -2;
    for ( let i = 0; i < v.length; i += 3 ) {
      const d = x * v[i] + y * v[i + 1] + z * v[i + 2];
      if ( d > dot ) dot = d;
    }
    return { c, dot };
  } ).sort( ( a, b ) => b.dot - a.dot );
  const kmTo = ( dot: number ) => EARTH_KM * Math.acos( Math.min( 1, dot ) );
  if ( nearest[0].dot === -2
    || ( nearest.length > 1 && kmTo( nearest[1].dot ) <= NEARBY_KM ) ) return split.shared;
  const [taxonId, sciName, commonName] = split.taxa[nearest[0].c];
  return [taxonId, sciName, commonName];
};
export interface AudioIdSetup {
  outputs: number[];
  species: AudioIdSpecies[]; // one per output, same order
  occurrence: number[]; // per output, geomodel score at the user's place, or -1
  located: boolean;
  location: UserLocation | null; // the user's, when no place was given
}

// The model output that scores `sp`, or -1 if the model no longer has it.
export const speciesOutput = ( sp: AudioIdSpecies ) => (
  SPECIES as [string, string, number, number, number][]
).findIndex( ( [name, , taxonId] ) => ( sp.modelName
  ? name === sp.modelName
  : taxonId === sp.taxonId && name === sp.name ) );

// BirdNET's 48-week year: four weeks per month.
const birdnetWeek = ( d: Date ) => d.getMonth( ) * 4
  + Math.min( 4, Math.floor( ( d.getDate( ) - 1 ) / 7 ) + 1 );

// For the user's place now, or a given place (null if unknown) and date.
export const prepareAudioId = async (
  geo: ( lat: number, lng: number, week: number ) => Promise<number[]>,
  place?: { latitude: number; longitude: number } | null,
  date = new Date( ),
): Promise<AudioIdSetup> => {
  const userLocation = place === undefined
    ? await fetchCoarseUserLocation( )
    : null;
  const location = place === undefined
    ? userLocation
    : place;
  const occurrence = location
    ? await geo( location.latitude, location.longitude, birdnetWeek( date ) )
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
      const sp = {
        name, commonName, taxonId, bird: !!bird,
      };
      const split = splitTaxon( name, location );
      species.push( split
        ? {
          ...sp, name: split[1], commonName: split[2], taxonId: split[0], modelName: name,
        }
        : sp );
      occ.push( occurrence && geoIndex >= 0
        ? occurrence[geoIndex]
        : -1 );
    },
  );
  return {
    outputs, species, occurrence: occ, located: !!location, location: userLocation,
  };
};
