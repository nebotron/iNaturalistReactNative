import { useQuery } from "@tanstack/react-query";
import { View } from "components/styledComponents";
import React, { useEffect, useMemo, useState } from "react";
import Svg, { Path } from "react-native-svg";
import { log } from "sharedHelpers/logger";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import type { AudioIdSpecies } from "./audioIdModel";
import { prepareAudioId, speciesOutput } from "./audioIdModel";
import { AudioBirdId, BINS_PER_S } from "./audioIdSession";

const logger = log.extend( "AudioId" );
const HEIGHT = 56;

const sigmoid = ( logit: number ) => 1 / ( 1 + Math.exp( -logit ) );

// Scored once per sound and set of outputs, as it takes a run of the model
// per 2.5 s of sound
type Logits = ( number | null )[];
const timelines = new Map<string, Promise<Logits>>( );
const MAX_TIMELINES = 20;

// The model's per-frame logits in each 1/3 s of the clip or sound at `uri`,
// as clipTimeline gives them for `outputs` (null where none were scored), or
// null until it is scored or when it can't be. A timeline the live session
// kept is used as it is.
const useTimeline = (
  uri: string,
  outputs: number[] | null,
  kept?: Logits,
) => {
  const key = outputs && outputs.length > 0
    ? `${uri}:${outputs.join( "," )}`
    : null;
  // Kept with what they score, so a new sound shows none until it is scored.
  const [scored, setScored] = useState<{ key: string; logits: Logits } | null>( null );
  const needed = !kept;
  useEffect( ( ) => {
    let current = true;
    if ( needed && key && outputs && AudioBirdId?.clipTimeline ) {
      let timeline = timelines.get( key );
      if ( !timeline ) {
        timeline = AudioBirdId.clipTimeline( uri, outputs );
        timelines.set( key, timeline );
        const [oldest] = timelines.keys( );
        if ( timelines.size > MAX_TIMELINES ) timelines.delete( oldest );
        timeline.catch( ( e: Error ) => {
          timelines.delete( key );
          logger.error( `scoring clip timeline failed: ${e.message}` );
        } );
      }
      timeline
        .then( logits => { if ( current ) setScored( { key, logits } ); } )
        .catch( ( ) => undefined );
    }
    return ( ) => { current = false; };
  }, [needed, key, uri, outputs] );
  if ( kept ) return kept;
  return scored && scored.key === key
    ? scored.logits
    : null;
};

// The timeline of `sp` in the Audio ID clip at `path`. Scoring a 15 s clip
// takes 5 runs of the model.
export const useClipTimeline = (
  path: string,
  sp: AudioIdSpecies,
  kept?: ( number | null )[],
) => {
  const output = speciesOutput( sp );
  const outputs = useMemo( ( ) => ( output >= 0
    ? [output]
    : null ), [output] );
  return useTimeline( path, outputs, kept );
};

// For a recorded sound, the timeline of whichever species likely at `place`
// and `date` (any species, where the place is unknown) the model finds most
// likely at each moment.
export const useSoundTimeline = (
  uri: string,
  place: { latitude: number; longitude: number } | null,
  date: Date,
) => {
  const { data: setup } = useQuery( {
    queryKey: ["audioIdSetup", place, date],
    queryFn: ( ) => ( AudioBirdId
      ? prepareAudioId( AudioBirdId.geo, place, date )
      : Promise.reject( new Error( "Audio ID is unavailable" ) ) ),
    enabled: !!AudioBirdId,
    staleTime: Infinity,
    retry: false,
  } );
  return useTimeline( uri, setup?.outputs ?? null );
};

interface Props {
  logits: ( number | null )[];
  duration: number;
  // Seconds from the clip's start, as the spectrogram above shows them;
  // without it, none of the clip is shaded
  trim?: [number, number];
  position: number;
}

// How likely the model hears the species at each moment of the clip (the
// sigmoid of its per-frame logits, which the clip's score pools over 5 s),
// lined up with the spectrogram above it.
const ClipProbabilityGraph = ( {
  logits, duration, trim = [0, duration], position,
}: Props ) => {
  const { t } = useTranslation( );
  const [width, setWidth] = useState( 0 );
  const x = ( at: number ) => ( Math.min( Math.max( at, 0 ), duration ) / duration ) * width;
  const y = ( p: number ) => ( 1 - Math.min( Math.max( p, 0 ), 1 ) ) * HEIGHT;
  // One stretch of line per run of scored bins, each at its bin's middle
  const stretches: [number, number][][] = [];
  logits.forEach( ( logit, i ) => {
    if ( logit == null ) {
      stretches.push( [] );
      return;
    }
    if ( stretches.length === 0 ) stretches.push( [] );
    const at = ( i + 0.5 ) / BINS_PER_S;
    stretches[stretches.length - 1].push( [x( at ), y( sigmoid( logit ) )] );
  } );
  const drawn = stretches.filter( pts => pts.length > 0 );
  const xy = ( [px, py]: [number, number] ) => `${px.toFixed( 1 )},${py.toFixed( 1 )}`;
  const line = drawn.map( pts => `M${pts.map( xy ).join( "L" )}` ).join( "" );
  const area = drawn
    .map( pts => `M${pts[0][0].toFixed( 1 )},${HEIGHT}L${pts.map( xy ).join( "L" )}`
      + `L${pts[pts.length - 1][0].toFixed( 1 )},${HEIGHT}Z` )
    .join( "" );
  const scoredLogits = logits.filter( ( l ): l is number => l != null );
  const peak = Math.round( sigmoid( Math.max( ...scoredLogits ) ) * 100 );
  const percent = ( at: number ) => `${( at / duration ) * 100}%`;

  return (
    <View
      className="mt-1 rounded overflow-hidden bg-lightGray"
      style={{ height: HEIGHT }}
      onLayout={e => setWidth( e.nativeEvent.layout.width )}
      accessible
      accessibilityLabel={t( "Probability-over-time-peaking-at-X-percent", { percent: peak } )}
    >
      {width > 0 && (
        <Svg width={width} height={HEIGHT}>
          <Path d={area} fill={colors.inatGreen} fillOpacity={0.3} />
          <Path d={line} stroke={colors.inatGreen} strokeWidth={2} fill="none" />
        </Svg>
      )}
      <View
        className="absolute h-full left-0 bg-black/20"
        style={{ width: percent( trim[0] ) }}
      />
      <View
        className="absolute h-full right-0 bg-black/20"
        style={{ width: percent( duration - trim[1] ) }}
      />
      <View
        className="absolute h-full w-0.5 bg-warningRed"
        style={{ left: percent( position ) }}
      />
    </View>
  );
};

export default ClipProbabilityGraph;
