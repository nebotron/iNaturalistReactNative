import useStore from "stores/useStore";
import factory from "tests/factory";

describe( "observation flow slice", ( ) => {
  beforeEach( ( ) => {
    useStore.getState( ).resetObservationFlowSlice( );
  } );

  describe( "setObservations", ( ) => {
    it( "clamps currentObservationIndex when replacing with a shorter list", ( ) => {
      const obsAt = index => factory( "LocalObservation", {
        uuid: `obs-${index}`,
      } );
      const obs0 = obsAt( 0 );
      const obs1 = obsAt( 1 );
      const obs2 = obsAt( 2 );

      useStore.setState( {
        observations: [obs0, obs1, obs2],
        currentObservationIndex: 2,
        currentObservation: obs2,
      } );

      const single = factory( "LocalObservation", { uuid: "new-single" } );
      useStore.getState( ).setObservations( [single] );

      const state = useStore.getState( );
      expect( state.observations ).toHaveLength( 1 );
      expect( state.currentObservationIndex ).toBe( 0 );
      expect( state.currentObservation?.uuid ).toBe( single.uuid );
    } );
  } );

  describe( "updateObservations", ( ) => {
    it( "clamps currentObservationIndex when the observation list becomes shorter", ( ) => {
      const obsAt = index => factory( "LocalObservation", {
        uuid: `obs-${index}`,
      } );
      const obs0 = obsAt( 0 );
      const obs1 = obsAt( 1 );

      useStore.setState( {
        observations: [obs0, obs1],
        currentObservationIndex: 1,
        currentObservation: obs1,
      } );

      const only = factory( "LocalObservation", { uuid: "only" } );
      useStore.getState( ).updateObservations( [only] );

      const state = useStore.getState( );
      expect( state.observations ).toHaveLength( 1 );
      expect( state.currentObservationIndex ).toBe( 0 );
      expect( state.currentObservation?.uuid ).toBe( only.uuid );
    } );
  } );

  describe( "setCurrentObservationIndex", ( ) => {
    it( "clamps the index when navigating past the end of the list", ( ) => {
      const obsAt = index => factory( "LocalObservation", {
        uuid: `obs-${index}`,
      } );
      const obs0 = obsAt( 0 );
      const obs1 = obsAt( 1 );

      useStore.setState( {
        observations: [obs0, obs1],
        currentObservationIndex: 0,
        currentObservation: obs0,
      } );

      useStore.getState( ).setCurrentObservationIndex( 5 );

      const state = useStore.getState( );
      expect( state.currentObservationIndex ).toBe( 1 );
      expect( state.currentObservation?.uuid ).toBe( obs1.uuid );
    } );
  } );

  describe( "removeObservationFromMultiObsFlowAtIndex", ( ) => {
    it( "keeps the viewer on the next observation when removing an earlier upload", ( ) => {
      const obsAt = index => factory( "LocalObservation", {
        uuid: `obs-${index}`,
      } );
      const obs0 = obsAt( 0 );
      const obs1 = obsAt( 1 );
      const obs2 = obsAt( 2 );

      useStore.setState( {
        observations: [obs0, obs1, obs2],
        currentObservationIndex: 2,
        currentObservation: obs2,
      } );

      useStore.getState( ).removeObservationFromMultiObsFlowAtIndex( 0 );

      const state = useStore.getState( );
      expect( state.observations ).toHaveLength( 2 );
      expect( state.currentObservationIndex ).toBe( 1 );
      expect( state.currentObservation?.uuid ).toBe( obs2.uuid );
    } );

    it( "clamps the index when the viewer was past the end after removal", ( ) => {
      const obsAt = index => factory( "LocalObservation", {
        uuid: `obs-${index}`,
      } );
      const obs0 = obsAt( 0 );
      const obs1 = obsAt( 1 );

      useStore.setState( {
        observations: [obs0, obs1],
        currentObservationIndex: 1,
        currentObservation: obs1,
      } );

      useStore.getState( ).removeObservationFromMultiObsFlowAtIndex( 0 );

      const state = useStore.getState( );
      expect( state.observations ).toHaveLength( 1 );
      expect( state.currentObservationIndex ).toBe( 0 );
      expect( state.currentObservation?.uuid ).toBe( obs1.uuid );
    } );
  } );
} );
