import { renderApp } from "tests/helpers/render";

describe( "Sharing photos into the app", () => {
  it( "mounts without the removed share-menu native integration", () => {
    const { unmount } = renderApp( );
    expect( typeof unmount ).toBe( "function" );
    unmount( );
  } );
} );
