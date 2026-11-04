/* eslint-disable i18next/no-literal-string */
import { Button } from "components/SharedComponents";
import { ScrollView, Text, View } from "components/styledComponents";
import React, { useEffect, useRef, useState } from "react";
import { Image, NativeModules, StyleSheet } from "react-native";
import { launchImageLibrary } from "react-native-image-picker";

// Tracked-location geotagging matches a photo's EXIF time against the phone's
// GPS log, so it's only as good as the agreement between the two clocks.
// Photograph this screen with the camera, then pick that photo: the QR code
// holds the phone time it was showing, and the difference from the photo's
// EXIF time is the camera's clock offset.

const { ImageCropper } = NativeModules as {
  ImageCropper: {
    qrCodePng: ( text: string ) => Promise<string>;
    readClockCheckPhoto: ( path: string ) => Promise<{
      dateTime: string | null;
      subsec: string | null;
      qr: string | null;
    }>;
  };
};

const styles = StyleSheet.create( {
  clock: { fontVariant: ["tabular-nums"] },
  content: { alignItems: "center", padding: 20 },
  fill: { height: "100%", width: "100%" },
} );

const REFRESH_MS = 100;
const IN_SYNC_MS = 2000;

const pad = ( n: number, width = 2 ) => String( n ).padStart( width, "0" );

const formatClock = ( ms: number ) => {
  const d = new Date( ms );
  return `${d.getHours( ) % 12 || 12}:${pad( d.getMinutes( ) )}:${pad( d.getSeconds( ) )}`
    + `.${Math.floor( d.getMilliseconds( ) / 100 )} ${d.getHours( ) < 12
      ? "AM"
      : "PM"}`;
};

const formatDuration = ( ms: number ) => {
  const totalSeconds = Math.abs( ms ) / 1000;
  const hours = Math.floor( totalSeconds / 3600 );
  const minutes = Math.floor( ( totalSeconds % 3600 ) / 60 );
  const seconds = ( totalSeconds % 60 ).toFixed( 1 );
  return [hours && `${hours} h`, ( hours || minutes ) && `${minutes} min`, `${seconds} s`]
    .filter( Boolean )
    .join( " " );
};

// EXIF times carry no zone, and geotagging reads them as phone-local time
// (new Date( observed_on_string )), so parse them the same way here; a camera
// set to the wrong time zone then shows up as an offset, as it should.
const parseExifMs = ( dateTime: string, subsec: string | null ) => {
  const m = dateTime.match( /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/ );
  if ( !m ) return null;
  const [year, month, day, hour, minute, second] = m.slice( 1 ).map( Number );
  // Without subseconds the capture happened somewhere in that second
  const fraction = subsec
    ? Number( `0.${subsec}` )
    : 0.5;
  return new Date( year, month - 1, day, hour, minute, second ).getTime( ) + fraction * 1000;
};

const CameraClockCheck = ( ) => {
  const [frame, setFrame] = useState<{ ms: number; qr: string } | null>( null );
  const [result, setResult] = useState<string | null>( null );
  const [checking, setChecking] = useState( false );
  const inFlight = useRef( false );

  useEffect( ( ) => {
    let cancelled = false;
    const tick = async ( ) => {
      if ( inFlight.current ) return;
      inFlight.current = true;
      const ms = Date.now( );
      try {
        const qr = await ImageCropper.qrCodePng( String( ms ) );
        if ( !cancelled ) setFrame( { ms, qr } );
      } finally {
        inFlight.current = false;
      }
    };
    tick( );
    const interval = setInterval( tick, REFRESH_MS );
    return ( ) => {
      cancelled = true;
      clearInterval( interval );
    };
  }, [] );

  const checkPhoto = async ( ) => {
    const picked = await launchImageLibrary( {
      mediaType: "photo",
      selectionLimit: 1,
      assetRepresentationMode: "current",
    } );
    const uri = picked.assets?.[0]?.uri;
    if ( !uri ) return;
    setChecking( true );
    try {
      const { dateTime, subsec, qr } = await ImageCropper.readClockCheckPhoto( uri );
      const screenMs = Number( qr );
      const exifMs = dateTime
        ? parseExifMs( dateTime, subsec )
        : null;
      if ( !qr || !Number.isFinite( screenMs ) ) {
        setResult( "No clock QR code found in that photo." );
      } else if ( exifMs === null ) {
        setResult( "That photo has no EXIF capture time." );
      } else {
        const offset = exifMs - screenMs;
        const verdict = Math.abs( offset ) < IN_SYNC_MS
          ? `Clocks are in sync (${formatDuration( offset )} apart).`
          : `Camera clock is ${formatDuration( offset )} ${offset > 0
            ? "fast"
            : "slow"}.`;
        setResult( [
          verdict,
          `Photo EXIF time: ${dateTime}${subsec
            ? `.${subsec}`
            : " (no subseconds, ±0.5 s)"}`,
          `Phone time on screen: ${formatClock( screenMs )}`,
        ].join( "\n\n" ) );
      }
    } catch ( error ) {
      setResult( `Couldn't read that photo: ${( error as Error ).message}` );
    } finally {
      setChecking( false );
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-white"
      contentContainerStyle={styles.content}
    >
      <Text className="text-center text-base mb-4">
        Photograph this screen with your camera, then import that photo below.
      </Text>
      <Text className="text-5xl font-bold mb-4" style={styles.clock}>
        {frame
          ? formatClock( frame.ms )
          : " "}
      </Text>
      <View className="w-[260px] h-[260px] bg-white">
        {frame && (
          <Image
            source={{ uri: frame.qr }}
            style={styles.fill}
            fadeDuration={0}
            accessibilityIgnoresInvertColors
          />
        )}
      </View>
      <Button
        className="mt-6 w-full"
        level="primary"
        text="CHECK PHOTO"
        loading={checking}
        onPress={checkPhoto}
      />
      {result && <Text className="text-base mt-5 self-stretch">{result}</Text>}
    </ScrollView>
  );
};

export default CameraClockCheck;
