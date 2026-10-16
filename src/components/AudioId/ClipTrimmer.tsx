/* eslint-disable i18next/no-literal-string */
import { exists } from "@dr.pogodin/react-native-fs";
import { Body3, INatIconButton } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useEffect, useLayoutEffect, useRef, useState,
} from "react";
import type { ViewProps } from "react-native";
import { PanResponder, requireNativeComponent } from "react-native";

import { clipPath, contextClipPath } from "./audioIdHistory";
import { AudioBirdId, setPlayingAudio } from "./audioIdSession";

export interface Span { path: string; startMs: number; endMs: number }

const AudioClipSpectrogram = requireNativeComponent<ViewProps & { path: string }>(
  "AudioClipSpectrogram",
);

// How close in points a touch has to land to grab a start or end handle
const GRAB = 24;
const MIN_CLIP = 0.2;
const SPECTROGRAM_STYLE = { height: 140 };

// The audio around a clip, with the trim it starts with: the 15 s context
// clip, trimmed to the whole of it or to the 5 s window the call was heard in
// (the context clip ends 5 s after the window, which ends about when the clip
// was heard). Clips from before context clips were saved fall back to the
// 5 s window.
export const useClipSpan = ( id: string, heardAt: number | undefined, whole: boolean ) => {
  const [span, setSpan] = useState<Span | null>( null );
  const [trim, setTrim] = useState<[number, number]>( [0, 0] );
  useEffect( ( ) => {
    if ( !heardAt ) return;
    exists( contextClipPath( id ) ).then( hasContext => {
      const s = hasContext
        ? { path: contextClipPath( id ), startMs: heardAt - 10000, endMs: heardAt + 5000 }
        : { path: clipPath( id ), startMs: heardAt - 5000, endMs: heardAt };
      const duration = ( s.endMs - s.startMs ) / 1000;
      setSpan( s );
      setTrim( whole || !hasContext
        ? [0, duration]
        : [5, 10] );
    } );
  }, [id, heardAt, whole] );
  return { span, trim, setTrim };
};

interface Props {
  span: Span;
  trim: [number, number];
  onTrimChange: ( trim: [number, number] ) => void;
  // Seconds from the span's start that labels count from and a line marks
  markerAt?: number;
}

// A clip's spectrogram: drag the handles to set where it starts and ends, or
// anywhere else to scrub, then hear it from there.
const ClipTrimmer = ( {
  span, trim, onTrimChange, markerAt,
}: Props ) => {
  const duration = ( span.endMs - span.startMs ) / 1000;
  // In seconds from the span's start
  const [position, setPosition] = useState( markerAt !== undefined
    ? Math.min( Math.max( markerAt, 0 ), duration )
    : trim[0] );
  const [playing, setPlaying] = useState( false );
  const [player] = useState( ( ) => ( {} ) );
  const timer = useRef<ReturnType<typeof setInterval>>( undefined );
  const playingRef = useRef( false );
  const width = useRef( 1 );

  useEffect( ( ) => {
    setPlayingAudio( player, playing );
    return ( ) => setPlayingAudio( player, false );
  }, [player, playing] );

  useEffect( ( ) => ( ) => {
    clearInterval( timer.current );
    if ( playingRef.current ) AudioBirdId?.stopClip( );
  }, [] );

  const stop = ( ) => AudioBirdId?.stopClip( );

  const play = async ( at: number ) => {
    const from = at >= trim[0] && at < trim[1] - 0.1
      ? at
      : trim[0];
    const started = Date.now( );
    setPlaying( true );
    playingRef.current = true;
    clearInterval( timer.current );
    timer.current = setInterval( ( ) => setPosition(
      Math.min( from + ( Date.now( ) - started ) / 1000, trim[1] ),
    ), 50 );
    await AudioBirdId?.playClipRange( span.path, from, trim[1] ).catch( ( ) => undefined );
    clearInterval( timer.current );
    playingRef.current = false;
    setPlaying( false );
  };

  // The responder is made once, so it reads the latest of these through a ref.
  const latest = useRef( { trim, onTrimChange, play } );
  useLayoutEffect( ( ) => { latest.current = { trim, onTrimChange, play }; } );
  const dragging = useRef<"start" | "end" | "scrub">( "scrub" );
  // Where the touch began, in points from the left edge
  const grantX = useRef( 0 );
  const seconds = ( x: number ) => Math.min( Math.max( x / width.current, 0 ), 1 ) * duration;
  const [responder] = useState( ( ) => PanResponder.create( {
    onStartShouldSetPanResponder: ( ) => true,
    onPanResponderTerminationRequest: ( ) => false,
    onPanResponderGrant: e => {
      const x = e.nativeEvent.locationX;
      grantX.current = x;
      const [start, end] = latest.current.trim;
      const toStart = Math.abs( x - ( start / duration ) * width.current );
      const toEnd = Math.abs( x - ( end / duration ) * width.current );
      if ( Math.min( toStart, toEnd ) <= GRAB ) {
        dragging.current = toStart < toEnd
          ? "start"
          : "end";
      } else {
        dragging.current = "scrub";
        stop( );
        setPosition( seconds( x ) );
      }
    },
    onPanResponderMove: ( _e, g ) => {
      const at = seconds( grantX.current + g.dx );
      const [start, end] = latest.current.trim;
      if ( dragging.current === "start" ) {
        latest.current.onTrimChange( [Math.min( at, end - MIN_CLIP ), end] );
      } else if ( dragging.current === "end" ) {
        latest.current.onTrimChange( [start, Math.max( at, start + MIN_CLIP )] );
      } else {
        setPosition( at );
      }
    },
    onPanResponderRelease: ( _e, g ) => {
      if ( dragging.current !== "scrub" ) return;
      const at = seconds( grantX.current + g.dx );
      setPosition( at );
      latest.current.play( at );
    },
  } ) );

  // Seconds relative to the marker, or from the span's start without one
  const label = ( at: number ) => {
    if ( markerAt === undefined ) return `${at.toFixed( 1 )} s`;
    const s = at - markerAt;
    return `${s >= 0
      ? "+"
      : "−"}${Math.abs( s ).toFixed( 1 )} s`;
  };
  const percent = ( at: number ) => `${( at / duration ) * 100}%`;
  const handle = ( at: number ) => (
    <View
      className="absolute h-full w-1 -ml-0.5 bg-inatGreen items-center justify-center"
      style={{ left: percent( at ) }}
    >
      <View className="w-3 h-8 rounded bg-inatGreen" />
    </View>
  );

  return (
    <View>
      <View
        className="mt-4 h-[140px] rounded overflow-hidden"
        onLayout={e => { width.current = e.nativeEvent.layout.width || 1; }}
        // eslint-disable-next-line react/jsx-props-no-spreading
        {...responder.panHandlers}
      >
        <AudioClipSpectrogram path={span.path} style={SPECTROGRAM_STYLE} pointerEvents="none" />
        {/* Touches pass through to the container, so locations are relative to it */}
        <View className="absolute inset-0" pointerEvents="none">
          <View
            className="absolute h-full left-0 bg-black/40"
            style={{ width: percent( trim[0] ) }}
          />
          <View
            className="absolute h-full right-0 bg-black/40"
            style={{ width: percent( duration - trim[1] ) }}
          />
          {markerAt !== undefined && markerAt >= 0 && markerAt <= duration && (
            <View
              className="absolute h-full w-0.5 bg-darkGray"
              style={{ left: percent( markerAt ) }}
            />
          )}
          <View
            className="absolute h-full w-0.5 bg-warningRed"
            style={{ left: percent( position ) }}
          />
          {handle( trim[0] )}
          {handle( trim[1] )}
        </View>
      </View>
      <View className="flex-row justify-between mt-1">
        <Body3>{`Start ${label( trim[0] )}`}</Body3>
        <Body3>{`End ${label( trim[1] )}`}</Body3>
      </View>
      <View className="flex-row items-center justify-between">
        <Body3>{label( position )}</Body3>
        <INatIconButton
          icon={playing
            ? "stop"
            : "play"}
          onPress={playing
            ? stop
            : ( ) => play( position )}
          accessibilityLabel={playing
            ? "Stop"
            : "Play"}
          accessibilityHint={playing
            ? "Stops the recording."
            : "Plays the trimmed clip from the playhead."}
        />
        <Body3>{`Clip ${( trim[1] - trim[0] ).toFixed( 1 )} s`}</Body3>
      </View>
    </View>
  );
};

export default ClipTrimmer;
