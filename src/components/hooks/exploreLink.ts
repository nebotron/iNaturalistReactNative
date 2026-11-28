import {
  HOTSPOTS_TAB,
  IDENTIFIERS_TAB,
  IDENTIFY_TAB,
  OBSERVATIONS_TAB,
  OBSERVERS_TAB,
  SPECIES_TAB,
} from "appConstants/tabs";
import type { ExploreTab } from "providers/ExploreContext";

// An Explore search from a web observations-search link, e.g.
// https://www.inaturalist.org/observations?user_id=ben142&taxon_ids=3,40151&view=identify
// The web's params and view names, plus route=lat,lng|lat,lng for the
// Hotspots view's stops, which the web has no equivalent of.
export interface ExploreLink {
  userLogin: string | null;
  taxonIds: number[];
  d1: string | null;
  d2: string | null;
  view: ExploreTab | null;
  route: { latitude: number; longitude: number }[];
}

const VIEWS: Record<string, ExploreTab> = {
  observations: OBSERVATIONS_TAB,
  species: SPECIES_TAB,
  identify: IDENTIFY_TAB,
  hotspots: HOTSPOTS_TAB,
  observers: OBSERVERS_TAB,
  identifiers: IDENTIFIERS_TAB,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const parseRoute = ( route: string | null ): ExploreLink["route"] => ( route || "" )
  .split( "|" )
  .map( pair => pair.split( "," ).map( Number ) )
  .filter( ( [lat, lng] ) => Number.isFinite( lat ) && Number.isFinite( lng )
    && Math.abs( lat ) <= 90 && Math.abs( lng ) <= 180 )
  .map( ( [latitude, longitude] ) => ( { latitude, longitude } ) );

// Null for anything but an observations search: an observation's own page
// (/observations/123) is handled separately
export const parseExploreLink = ( pathname: string, search: string ): ExploreLink | null => {
  if ( pathname.replace( /\/+$/, "" ) !== "/observations" ) return null;
  const params = new URLSearchParams( search );
  const date = ( key: string ) => {
    const value = params.get( key );
    return value && DATE.test( value )
      ? value
      : null;
  };
  return {
    userLogin: params.get( "user_id" ) || null,
    taxonIds: ( params.get( "taxon_ids" ) || params.get( "taxon_id" ) || "" )
      .split( "," )
      .map( Number )
      .filter( id => Number.isInteger( id ) && id > 0 ),
    d1: date( "d1" ),
    d2: date( "d2" ),
    view: VIEWS[params.get( "view" ) || ""] || null,
    route: parseRoute( params.get( "route" ) ),
  };
};
