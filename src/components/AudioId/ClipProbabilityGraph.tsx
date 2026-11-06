import { Body3 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import Svg, { Line, Path } from "react-native-svg";
import { log } from "sharedHelpers/logger";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import type { AudioIdSpecies } from "./audioIdModel";
import { speciesOutput } from "./audioIdModel";
import {
  AudioBirdId, BINS_PER_S, CALL_LOGIT,
} from "./audioIdSession";

const logger = log.extend( "AudioId" );
const HEIGHT = 56;

const sigmoid = ( logit: number ) => 1 / ( 1 + Math.exp( -logit ) );

interface Scored { key: string; logits: ( number | null )[] }

// The model's per-frame logits for `sp` in each 1/3 s of the clip at `path`
// (null where none were scored), or null until it is scored or when it can't
// be. A timeline the live session kept is used as it is; otherwise the clip
// is scored, which takes 5 runs of the model for a 15 s clip.
export const useClipTimeline = (
  path: string,
  sp: AudioIdSpecies,
  kept?: ( number | null )[],
) => {
  const output = speciesOutput( sp );
  const key = `${path}:${output}`;
  // Kept with what they score, so a new clip shows none until it is scored.
  const [scored, setScored] = useState<Scored | null>( null );
  const needed = !kept;
  useEffect( ( ) => {
    let current = true;
    if ( needed && output >= 0 && AudioBirdId?.clipTimeline ) {
      AudioBirdId.clipTimeline( path, output )
        .then( logits => { if ( current ) setScored( { key, logits } ); } )
        .catch( ( e: Error ) => logger.error( `scoring clip timeline failed: ${e.message}` ) );
    }
    return ( ) => { current = false; };
  }, [needed, path, output, key] );
  if ( kept ) return kept;
  return scored?.key === key
    ? scored.logits
    : null;
};

interface Props {
  logits: ( number | null )[];
  duration: number;
  // Seconds from the clip's start, as the spectrogram above shows them
  trim: [number, number];
  position: number;
  speciesName: string;
}

// How likely the model hears the species at each moment of the clip (the
// sigmoid of its per-frame logits, which the clip's score pools over 5 s),
// lined up with the spectrogram above it, with the level a call is found at.
const ClipProbabilityGraph = ( {
  logits, duration, trim, position, speciesName,
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
          <Line
            x1={0}
            x2={width}
            y1={y( sigmoid( CALL_LOGIT ) )}
            y2={y( sigmoid( CALL_LOGIT ) )}
            stroke={colors.darkGray}
            strokeWidth={1}
            strokeDasharray="4,4"
          />
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
      <Body3 className="absolute top-0.5 left-1 text-darkGray">
        {t( "X-percent", { count: 100 } )}
      </Body3>
      <Body3 className="absolute bottom-0.5 left-1 text-darkGray">
        {t( "X-percent", { count: 0 } )}
      </Body3>
      <Body3 className="absolute top-0.5 right-1 text-darkGray" numberOfLines={1}>
        {t( "X-probability-over-time", { name: speciesName } )}
      </Body3>
    </View>
  );
};

export default ClipProbabilityGraph;
