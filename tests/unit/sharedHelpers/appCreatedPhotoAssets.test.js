import {
  appCreatedPhotoUris,
  basePhotoAssetId,
  forgetAppCreatedPhotoAssets,
  isAppCreatedDeleteExemptionConfirmed,
  recordAppCreatedDeletionTiming,
  recordAppCreatedPhotoAssets,
} from "sharedHelpers/appCreatedPhotoAssets";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "66666666-7777-8888-9999-000000000000";

describe( "appCreatedPhotoAssets", ( ) => {
  beforeEach( ( ) => {
    forgetAppCreatedPhotoAssets( [UUID_A, UUID_B] );
    recordAppCreatedDeletionTiming( 0 );
  } );

  it( "compares identifiers on the UUID, however they are spelled", ( ) => {
    expect( basePhotoAssetId( `ph://${UUID_A}/L0/001` ) ).toEqual( UUID_A );
    expect( basePhotoAssetId( UUID_A ) ).toEqual( UUID_A );
  } );

  it( "recognises an asset it recorded, whichever form the uri takes", ( ) => {
    // Photos hands back the suffixed identifier at creation...
    recordAppCreatedPhotoAssets( [`${UUID_A}/L0/001`] );

    // ...and the deletion asks about the ph:// uri the app carries around.
    expect( appCreatedPhotoUris( [`ph://${UUID_A}`, `ph://${UUID_B}`] ) )
      .toEqual( [`ph://${UUID_A}`] );
  } );

  it( "forgets an asset once it has been deleted", ( ) => {
    recordAppCreatedPhotoAssets( [UUID_A] );
    forgetAppCreatedPhotoAssets( [`ph://${UUID_A}/L0/001`] );

    expect( appCreatedPhotoUris( [`ph://${UUID_A}`] ) ).toEqual( [] );
  } );

  it( "confirms the exemption while the unprompted delete comes back fast", ( ) => {
    recordAppCreatedDeletionTiming( 400 );
    expect( isAppCreatedDeleteExemptionConfirmed( ) ).toBe( true );
  } );

  it( "withholds the exemption for a delete slow enough to have been prompted", ( ) => {
    // Slow enough for the user to have read and tapped an alert, but well
    // short of the 10s this used to allow.
    recordAppCreatedDeletionTiming( 3_000 );
    expect( isAppCreatedDeleteExemptionConfirmed( ) ).toBe( false );
  } );

  it( "leaves the verdict alone when the delete never came back", ( ) => {
    // A transaction that hung says nothing about whether it would have
    // prompted, so it must not change the verdict either way.
    recordAppCreatedDeletionTiming( 3_000 );
    recordAppCreatedDeletionTiming( -1 );
    expect( isAppCreatedDeleteExemptionConfirmed( ) ).toBe( false );

    recordAppCreatedDeletionTiming( 400 );
    recordAppCreatedDeletionTiming( -1 );
    expect( isAppCreatedDeleteExemptionConfirmed( ) ).toBe( true );
  } );
} );
