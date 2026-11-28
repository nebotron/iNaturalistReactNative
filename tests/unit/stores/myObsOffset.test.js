import useStore from "stores/useStore";

describe( "My Observations scroll offset", ( ) => {
  beforeEach( ( ) => {
    useStore.getState( ).setMyObsOffset( 0 );
    useStore.getState( ).resetMyObsOffsetToRestore( );
  } );

  it( "doesn't notify store subscribers on every scroll event", ( ) => {
    const listener = jest.fn( );
    const unsubscribe = useStore.subscribe( listener );
    useStore.getState( ).setMyObsOffset( 120 );
    useStore.getState( ).setMyObsOffset( 480 );
    unsubscribe( );
    expect( listener ).not.toHaveBeenCalled( );
  } );

  it( "saves the latest offset to restore", ( ) => {
    useStore.getState( ).setMyObsOffset( 120 );
    useStore.getState( ).setMyObsOffset( 480 );
    useStore.getState( ).setMyObsOffsetToRestore( );
    expect( useStore.getState( ).myObsOffsetToRestore ).toBe( 480 );
    useStore.getState( ).resetMyObsOffsetToRestore( );
    expect( useStore.getState( ).myObsOffsetToRestore ).toBe( 0 );
  } );
} );
