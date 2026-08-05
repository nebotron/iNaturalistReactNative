import {
  appCreatedPhotoUris,
  basePhotoAssetId,
  forgetAppCreatedPhotoAssets,
  isAppCreatedDeleteExemptionRuledOut,
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

  it( "keeps splitting while the unprompted delete comes back fast", ( ) => {
    recordAppCreatedDeletionTiming( 400 );
    expect( isAppCreatedDeleteExemptionRuledOut( ) ).toBe( false );
  } );

  it( "stops splitting once a delete takes long enough to have been prompted", ( ) => {
    recordAppCreatedDeletionTiming( 12_000 );
    expect( isAppCreatedDeleteExemptionRuledOut( ) ).toBe( true );
  } );

  it( "leaves the verdict open when the delete never came back", ( ) => {
    // A transaction that hung says nothing about whether it would have
    // prompted, so it must not rule the exemption out.
    recordAppCreatedDeletionTiming( 12_000 );
    recordAppCreatedDeletionTiming( -1 );
    expect( isAppCreatedDeleteExemptionRuledOut( ) ).toBe( true );

    recordAppCreatedDeletionTiming( 400 );
    recordAppCreatedDeletionTiming( -1 );
    expect( isAppCreatedDeleteExemptionRuledOut( ) ).toBe( false );
  } );
} );
