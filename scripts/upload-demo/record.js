/**
 * Playwright script: records the iNaturalist observation upload demo.
 * Uses the pre-installed Chromium at /opt/pw-browsers.
 * Output: ../../assets/upload-demo.webm
 */

const { chromium } = require( "playwright" );
const path = require( "path" );
const fs = require( "fs" );
const http = require( "http" );

// ── Serve demo.html on a local port ──
async function startServer( port ) {
  const htmlPath = path.join( __dirname, "demo.html" );
  return new Promise( ( resolve, reject ) => {
    const server = http.createServer( ( req, res ) => {
      fs.readFile( htmlPath, ( err, data ) => {
        if ( err ) {
          res.writeHead( 500 );
          res.end( "Error loading demo.html" );
          return;
        }
        res.writeHead( 200, { "Content-Type": "text/html; charset=utf-8" } );
        res.end( data );
      } );
    } );
    server.listen( port, "127.0.0.1", () => {
      console.log( `Demo server running at http://127.0.0.1:${port}` );
      resolve( server );
    } );
    server.on( "error", reject );
  } );
}

const sleep = ( ms ) => new Promise( r => setTimeout( r, ms ) );

// Phone dimensions (iPhone 14 viewport)
const PHONE_W = 390;
const PHONE_H = 844;

// Outer browser window — a bit wider for phone frame
const WIN_W = 600;
const WIN_H = 920;

async function main() {
  const port = 9171;
  const server = await startServer( port );
  const url = `http://127.0.0.1:${port}/`;

  const outputDir = path.join( __dirname, "video-out" );
  fs.mkdirSync( outputDir, { recursive: true } );

  const browser = await chromium.launch( {
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  } );

  const context = await browser.newContext( {
    viewport: { width: WIN_W, height: WIN_H },
    recordVideo: {
      dir: outputDir,
      size: { width: WIN_W, height: WIN_H },
    },
    deviceScaleFactor: 1,
  } );

  const page = await context.newPage();
  await page.goto( url, { waitUntil: "domcontentloaded" } );
  await sleep( 800 );

  // ── Helper: tap at phone-frame-relative coords ──
  // The phone is centered in the 600px-wide window, so left offset = (600-390)/2 = 105
  const PX = 105; // phone left offset in window
  const PY = ( WIN_H - PHONE_H ) / 2; // phone top offset

  async function tap( relX, relY, label = "" ) {
    const x = Math.round( PX + relX );
    const y = Math.round( PY + relY );
    if ( label ) console.log( `  tap: ${label} @ (${relX}, ${relY})` );
    await page.mouse.move( x, y );
    await sleep( 120 );
    await page.mouse.down();
    await sleep( 80 );
    await page.mouse.up();
  }

  async function clickById( id, label = "" ) {
    if ( label ) console.log( `  click: ${label}` );
    await page.locator( `#${id}` ).click();
  }

  console.log( "\n▶  Screen 1: My Observations" );
  await sleep( 2500 ); // hold on the observations list

  console.log( "\n▶  Tapping FAB to open Add Observation sheet" );
  await clickById( "fab", "FAB +" );
  await sleep( 800 );

  console.log( "\n▶  Sheet is open — pausing to show options" );
  await sleep( 2000 );

  console.log( "\n▶  Tapping Upload photos" );
  await clickById( "btn-library", "Upload photos" );
  await sleep( 600 );

  console.log( "\n▶  Screen 2: Photo Library" );
  await sleep( 2000 );

  // The monarch photo is already selected; tap Import
  console.log( "\n▶  Tapping Import button" );
  await clickById( "lib-import-btn", "Import 1 Photo" );
  await sleep( 600 );

  console.log( "\n▶  Screen 3: AI Suggestions (animating confidence bars)" );
  await sleep( 2500 ); // wait for bar animation

  console.log( "\n▶  Tapping 'Select Monarch Butterfly'" );
  await clickById( "sug-select-btn", "Select Monarch Butterfly" );
  await sleep( 500 );

  console.log( "\n▶  Screen 4: Observation Edit" );
  await sleep( 3000 );

  console.log( "\n▶  Tapping Upload Observation" );
  await clickById( "upload-btn", "Upload Observation" );
  await sleep( 500 );

  console.log( "\n▶  Screen 5: Upload progress" );
  await sleep( 4000 ); // wait for progress bar animation + transition

  console.log( "\n▶  Screen 6: Success! Hold on result…" );
  await sleep( 3500 );

  console.log( "\nClosing browser…" );
  await context.close();
  await browser.close();
  server.close();

  // Playwright writes the video file when the context closes.
  // Find the generated webm.
  const files = fs.readdirSync( outputDir ).filter( f => f.endsWith( ".webm" ) );
  if ( files.length === 0 ) {
    console.error( "No video file found in", outputDir );
    process.exit( 1 );
  }

  const src = path.join( outputDir, files[0] );
  const destDir = path.join( __dirname, "..", "..", "assets" );
  const dest = path.join( destDir, "upload-demo.webm" );
  fs.mkdirSync( destDir, { recursive: true } );
  fs.copyFileSync( src, dest );
  console.log( `\n✅  Video saved to: ${dest}` );
}

main().catch( err => { console.error( err ); process.exit( 1 ); } );
