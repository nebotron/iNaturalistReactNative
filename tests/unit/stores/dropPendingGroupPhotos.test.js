import { dropPendingGroupPhotos } from "stores/createObservationFlowSlice";

const photo = ( uri, pending = false ) => ( {
  image: { uri },
  ...( pending
    ? { pending: true }
    : {} ),
} );

describe( "dropPendingGroupPhotos", ( ) => {
  it( "returns the same list when nothing is pending", ( ) => {
    const groups = [{ photos: [photo( "a" )] }, { soundUri: "s" }];
    expect( dropPendingGroupPhotos( groups ) ).toBe( groups );
  } );

  it( "drops pending photos and groups left empty", ( ) => {
    const sound = { photos: [photo( "c", true )], soundUri: "s" };
    const groups = [
      { photos: [photo( "a" ), photo( "b", true )] },
      { photos: [photo( "d", true )] },
      sound,
    ];
    expect( dropPendingGroupPhotos( groups ) ).toEqual( [
      { photos: [photo( "a" )] },
      { photos: [], soundUri: "s" },
    ] );
  } );

  it( "keeps groups without pending photos as the same objects", ( ) => {
    const settled = { photos: [photo( "a" )] };
    const groups = [settled, { photos: [photo( "b", true )] }];
    expect( dropPendingGroupPhotos( groups )[0] ).toBe( settled );
  } );

  // persist runs it on every store write, and a new list each time made the
  // persist layer rewrite Group Photos on writes that never touched it
  it( "returns the same output for the same input", ( ) => {
    const groups = [{ photos: [photo( "a" ), photo( "b", true )] }];
    expect( dropPendingGroupPhotos( groups ) ).toBe( dropPendingGroupPhotos( groups ) );
  } );
} );
