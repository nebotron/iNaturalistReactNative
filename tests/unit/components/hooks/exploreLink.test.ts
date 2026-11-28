import { HOTSPOTS_TAB, IDENTIFY_TAB } from "appConstants/tabs";
import { parseExploreLink } from "components/hooks/exploreLink";

const parse = ( url: string ) => {
  const { pathname, search } = new URL( url );
  return parseExploreLink( pathname, search );
};

describe( "parseExploreLink", ( ) => {
  it( "reads a web observations search", ( ) => {
    expect( parse(
      "https://www.inaturalist.org/observations?user_id=ben142&taxon_ids=3,40151"
        + "&d1=2026-01-01&d2=2026-02-01&view=identify",
    ) ).toEqual( {
      userLogin: "ben142",
      taxonIds: [3, 40151],
      d1: "2026-01-01",
      d2: "2026-02-01",
      view: IDENTIFY_TAB,
      route: [],
    } );
  } );

  it( "reads the same search from the app's own scheme", ( ) => {
    expect( parse(
      "inaturalistmobile://www.inaturalist.org/observations/?taxon_id=3",
    )?.taxonIds ).toEqual( [3] );
  } );

  it( "reads a hotspots route", ( ) => {
    const link = parse(
      "https://www.inaturalist.org/observations?view=hotspots"
        + "&route=47.656,-122.296|47.6573,-122.4055",
    );
    expect( link?.view ).toBe( HOTSPOTS_TAB );
    expect( link?.route ).toEqual( [
      { latitude: 47.656, longitude: -122.296 },
      { latitude: 47.6573, longitude: -122.4055 },
    ] );
  } );

  it( "drops values it can't use", ( ) => {
    expect( parse(
      "https://www.inaturalist.org/observations?taxon_ids=3,abc,-1&d1=yesterday"
        + "&view=map&route=91,0|x,y",
    ) ).toEqual( {
      userLogin: null,
      taxonIds: [3],
      d1: null,
      d2: null,
      view: null,
      route: [],
    } );
  } );

  it( "leaves an observation's own page alone", ( ) => {
    expect( parse( "https://www.inaturalist.org/observations/387561919" ) ).toBeNull( );
  } );
} );
