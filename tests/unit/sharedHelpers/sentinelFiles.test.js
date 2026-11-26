import { parseSentinelContent } from "sharedHelpers/sentinelFiles";

describe( "parseSentinelContent", ( ) => {
  it( "reads a flow line followed by appended stage lines", ( ) => {
    const content = [
      JSON.stringify( { screenName: "Camera", entryTimestamp: "t0", stages: [] } ),
      JSON.stringify( { name: "permissions", timestamp: "t1" } ),
      JSON.stringify( { name: "flow_complete", timestamp: "t2" } ),
      "",
    ].join( "\n" );

    expect( parseSentinelContent( content ) ).toEqual( {
      screenName: "Camera",
      entryTimestamp: "t0",
      stages: [
        { name: "permissions", timestamp: "t1" },
        { name: "flow_complete", timestamp: "t2" },
      ],
    } );
  } );

  it( "reads the single-object files earlier builds wrote", ( ) => {
    const content = JSON.stringify( {
      screenName: "Camera",
      entryTimestamp: "t0",
      stages: [{ name: "save_photo", timestamp: "t1" }],
    } );

    expect( parseSentinelContent( content ).stages ).toEqual( [
      { name: "save_photo", timestamp: "t1" },
    ] );
  } );

  it( "keeps the stages before a line cut short", ( ) => {
    const content = [
      JSON.stringify( { screenName: "Camera", stages: [] } ),
      JSON.stringify( { name: "permissions", timestamp: "t1" } ),
      "{\"name\":\"save_ph",
    ].join( "\n" );

    expect( parseSentinelContent( content ).stages ).toEqual( [
      { name: "permissions", timestamp: "t1" },
    ] );
  } );

  it( "reads a file that starts with a stage", ( ) => {
    const content = `${JSON.stringify( { name: "location", timestamp: "t1" } )}\n`;

    expect( parseSentinelContent( content ).stages ).toEqual( [
      { name: "location", timestamp: "t1" },
    ] );
  } );
} );
