import queueSubjectDetection, {
  prioritizeSubjectDetection,
} from "sharedHelpers/subjectDetectionQueue";

// A job that only finishes when the test says so
const deferredJob = ( name: string, started: string[] ) => {
  let finish: ( ) => void = ( ) => undefined;
  const work = ( ) => new Promise<string>( resolve => {
    started.push( name );
    finish = ( ) => resolve( name );
  } );
  return { work, finish: ( ) => finish( ) };
};

const flush = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

describe( "queueSubjectDetection", ( ) => {
  it( "runs at most two jobs at once, the photo on screen first", async ( ) => {
    const started: string[] = [];
    const a = deferredJob( "a", started );
    const b = deferredJob( "b", started );
    const ahead = deferredJob( "ahead", started );
    const onScreen = deferredJob( "onScreen", started );

    const results = [
      queueSubjectDetection( a.work ),
      queueSubjectDetection( b.work ),
      queueSubjectDetection( ahead.work, { inAdvance: true } ),
      queueSubjectDetection( onScreen.work ),
    ];
    expect( started ).toEqual( ["a", "b"] );

    a.finish( );
    await flush( );
    expect( started ).toEqual( ["a", "b", "onScreen"] );

    b.finish( );
    await flush( );
    expect( started ).toEqual( ["a", "b", "onScreen", "ahead"] );

    onScreen.finish( );
    ahead.finish( );
    await expect( Promise.all( results ) ).resolves.toEqual( ["a", "b", "ahead", "onScreen"] );
  } );

  it( "moves a job queued in advance ahead once its photo is on screen", async ( ) => {
    const started: string[] = [];
    const a = deferredJob( "a", started );
    const b = deferredJob( "b", started );
    const first = deferredJob( "first", started );
    const second = deferredJob( "second", started );

    const results = [
      queueSubjectDetection( a.work ),
      queueSubjectDetection( b.work ),
      queueSubjectDetection( first.work, { inAdvance: true, key: "first" } ),
      queueSubjectDetection( second.work, { inAdvance: true, key: "second" } ),
    ];
    prioritizeSubjectDetection( "second" );

    a.finish( );
    await flush( );
    expect( started ).toEqual( ["a", "b", "second"] );

    b.finish( );
    second.finish( );
    await flush( );
    first.finish( );
    await expect( Promise.all( results ) ).resolves.toEqual( ["a", "b", "first", "second"] );
  } );
} );
