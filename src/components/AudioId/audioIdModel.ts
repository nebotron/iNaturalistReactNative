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

const kmBetween = ( lat1: number, lng1: number, lat2: number, lng2: number ) => {
  const rad = Math.PI / 180;
  const h = Math.sin( ( ( lat2 - lat1 ) * rad ) / 2 ) ** 2
    + Math.cos( lat1 * rad ) * Math.cos( lat2 * rad )
    * Math.sin( ( ( lng2 - lng1 ) * rad ) / 2 ) ** 2;
  return 12742 * Math.asin( Math.min( 1, Math.sqrt( h ) ) );
};

// The iNaturalist taxon for BirdNET's species `name` at `location`, or null
// if iNaturalist hasn't split it.
export const splitTaxon = (
  name: string,
  location: { latitude: number; longitude: number } | null,
): SplitTaxon | null => {
  const split = ( SPLITS as Record<string, Split> )[name];
  if ( !split ) return null;
  if ( !location ) return split.shared;
  const { latitude, longitude } = location;
  const nearest = split.taxa.map( ( [taxonId, sciName, commonName, points] ) => {
    let km = Infinity;
    for ( let i = 0; i < points.length; i += 2 ) {
      km = Math.min( km, kmBetween( latitude, longitude, points[i] / 2, points[i + 1] / 2 ) );
    }
    return { taxon: [taxonId, sciName, commonName] as SplitTaxon, km };
  } ).sort( ( a, b ) => a.km - b.km );
  return nearest[0].km === Infinity || ( nearest.length > 1 && nearest[1].km <= NEARBY_KM )
    ? split.shared
    : nearest[0].taxon;
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
