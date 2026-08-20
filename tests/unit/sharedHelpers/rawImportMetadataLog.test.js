import * as Exify from "@lodev09/react-native-exify";

const mockReadCr3SummaryFromFile = jest.fn( );
jest.mock( "sharedHelpers/cr3Metadata", ( ) => ( {
  isCanonRawUri: uri => Boolean( uri && uri.toLowerCase( ).endsWith( ".cr3" ) ),
  readCr3SummaryFromFile: ( ...args ) => mockReadCr3SummaryFromFile( ...args ),
} ) );

const mockLogger = { info: jest.fn( ), warn: jest.fn( ), error: jest.fn( ) };
const mockExtra = { infoWithExtra: jest.fn( ), warnWithExtra: jest.fn( ) };
jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      info: ( ...args ) => mockLogger.info( ...args ),
      warn: ( ...args ) => mockLogger.warn( ...args ),
      error: ( ...args ) => mockLogger.error( ...args ),
      infoWithExtra: ( ...args ) => mockExtra.infoWithExtra( ...args ),
      warnWithExtra: ( ...args ) => mockExtra.warnWithExtra( ...args ),
    } ),
  },
} ) );

// eslint-disable-next-line global-require
const logRawImportMetadata = require( "sharedHelpers/rawImportMetadataLog" ).default;

const RAW = "file:///gallery/3S1A6473.CR3";
const JPEG = "file:///photoUploads/3S1A6473.jpg";

const summary = {
  make: "Canon",
  camera: "Canon EOS R7",
  lens: "RF-S18-150mm F3.5-6.3 IS STM",
  makerNoteLens: "RF-S18-150mm F3.5-6.3 IS STM",
  focalLength: 150,
  fNumber: 8,
  iso: 100,
  hasGps: true,
  sensorWidth: 7128,
  sensorHeight: 4732,
  activeWidth: 6960,
  activeHeight: 4640,
  cropWidth: 6960,
  cropHeight: 4640,
  cropLeft: 0,
  cropTop: 0,
  peripheralLighting: 1,
  chromaticAberrationCorrection: 1,
  distortionCorrection: 0,
  digitalLensOptimizer: 1,
  packetVersion: 97,
  packetBytes: 1500,
  exifTags: [0x829d, 0x920a],
  makerNoteTags: [0x0095, 0x4016],
  ctmdRecordTypes: [1, 7, 8, 9],
  curves: [
    {
      kind: "falloff",
      points: 17,
      first: 1,
      last: 0.512,
      low: 0.512,
      high: 1,
      knotCount: 16,
      knotLast: 2934,
    },
  ],
};

describe( "logRawImportMetadata", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    mockReadCr3SummaryFromFile.mockResolvedValue( summary );
    Exify.read.mockResolvedValue( { LensModel: "RF-S18-150mm F3.5-6.3 IS STM", FocalLength: 150 } );
  } );

  it( "reports what the raw held and what the JPEG kept", async ( ) => {
    expect( await logRawImportMetadata( [RAW], [JPEG] ) ).toBe( true );

    expect( mockExtra.infoWithExtra ).toHaveBeenCalledWith(
      "raw_import_metadata",
      expect.objectContaining( {
        camera: "Canon EOS R7",
        lens: "RF-S18-150mm F3.5-6.3 IS STM",
        focalLength: 150,
        sensor: "7128x4732",
        active: "6960x4640",
        inCameraCorrections: "periph=1 ca=1 dist=0 dlo=1",
        exifTags: "0x829d,0x920a",
        makerNoteTags: "0x95,0x4016",
        ctmdRecords: "1,7,8,9",
        lensPacket: "v97 1500B",
        curves: "falloff:17:1.000>0.512:[0.512,1.000]:k16/2934",
        derivedType: "jpg",
        derivedLens: "RF-S18-150mm F3.5-6.3 IS STM",
      } ),
    );
  } );

  it( "says nothing when the import held no raw file", async ( ) => {
    expect( await logRawImportMetadata( [JPEG], [JPEG] ) ).toBe( false );
    expect( mockReadCr3SummaryFromFile ).not.toHaveBeenCalled( );
    expect( mockExtra.infoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "reports a raw it could not parse rather than staying silent", async ( ) => {
    mockReadCr3SummaryFromFile.mockResolvedValue( null );

    expect( await logRawImportMetadata( [RAW], [JPEG] ) ).toBe( false );
    expect( mockExtra.warnWithExtra ).toHaveBeenCalledWith(
      "raw_import_metadata_unreadable",
      expect.objectContaining( { sourceType: "cr3" } ),
    );
  } );

  it( "records that ImageIO could not open the file, rather than throwing", async ( ) => {
    Exify.read.mockRejectedValue( new Error( "Invalid URI" ) );

    expect( await logRawImportMetadata( [RAW], [JPEG] ) ).toBe( true );
    expect( mockExtra.infoWithExtra ).toHaveBeenCalledWith(
      "raw_import_metadata",
      expect.objectContaining( { sourceExifReadable: false, derivedExifReadable: false } ),
    );
  } );

  it( "never lets a parse failure reach the import", async ( ) => {
    mockReadCr3SummaryFromFile.mockRejectedValue( new Error( "unreadable" ) );

    await expect( logRawImportMetadata( [RAW], [JPEG] ) ).resolves.toBe( false );
    expect( mockLogger.error ).toHaveBeenCalled( );
  } );
} );
