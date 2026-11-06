import { Body3 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useEffect, useState } from "react";
import Svg, { Line, Path } from "react-native-svg";
import { log } from "sharedHelpers/logger";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import type { AudioIdSpecies } from "./audioIdModel";
import { speciesOutput } from "./audioIdModel";
import { AudioBirdId, THRESHOLD } from "./audioIdSession";

const logger = log.extend( "AudioId" );

// Seconds between scores: 61 windows for a 15 s clip, scored off the main
// thread in a few seconds.
const HOP_S = 0.25;
const HEIGHT = 56;

// The model's probability for `sp` at each HOP_S of the clip at `path`, or
// null until it is scored (or when it can't be).
export const useClipProbabilities = (
  path: string | undefined,
  sp: AudioIdSpecies | undefined,
) => {
  const output = sp
    ? speciesOutput( sp )
    : -1;
  const key = `${path}:${output}`;
  // Kept with what they score, so a new clip shows none until it is scored.
  const [scored, setScored] = useState<{ key: string; scores: number[] } | null>( null );
  useEffect( ( ) => {
    let current = true;
    if ( path && output >= 0 && AudioBirdId?.clipTimeline ) {
      AudioBirdId.clipTimeline( path, output, HOP_S )
        .then( scores => { if ( current ) setScored( { key, scores } ); } )
        .catch( ( e: Error ) => logger.error( `scoring clip timeline failed: ${e.message}` ) );
    }
    return ( ) => { current = false; };
  }, [path, output, key] );
  return scored?.key === key
    ? scored.scores
    : null;
};

interface Props {
  probabilities: number[];
  duration: number;
  // Seconds from the clip's start, as the spectrogram above shows them
  trim: [number, number];
  position: number;
  speciesName: string;
}

// How likely the model hears the species at each moment of the clip, lined up
// with the spectrogram above it, with the threshold for counting it as heard.
const ClipProbabilityGraph = ( {
  probabilities, duration, trim, position, speciesName,
}: Props ) => {
  const { t } = useTranslation( );
  const [width, setWidth] = useState( 0 );
  const x = ( at: number ) => ( Math.min( Math.max( at, 0 ), duration ) / duration ) * width;
  const y = ( p: number ) => ( 1 - Math.min( Math.max( p, 0 ), 1 ) ) * HEIGHT;
  const points = probabilities
    .map( ( p, i ) => `${x( i * HOP_S ).toFixed( 1 )},${y( p ).toFixed( 1 )}` );
  const line = `M${points.join( "L" )}`;
  const lastX = x( ( probabilities.length - 1 ) * HOP_S ).toFixed( 1 );
  const area = `${line}L${lastX},${HEIGHT}L0,${HEIGHT}Z`;
  const peak = Math.round( Math.max( ...probabilities ) * 100 );
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
            y1={y( THRESHOLD )}
            y2={y( THRESHOLD )}
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
