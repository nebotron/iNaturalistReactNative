import { Body4 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { usesMetricSystem } from "react-native-localize";
import type { Region } from "react-native-maps";

const MAX_BAR_WIDTH = 100;
const METERS_PER_DEGREE = 111320;
const METERS_PER_MILE = 1609.344;
const METERS_PER_FOOT = 0.3048;

const niceNumber = ( max: number ) => {
  const pow = 10 ** Math.floor( Math.log10( max ) );
  return [5, 2, 1].map( n => n * pow ).find( n => n <= max ) || pow;
};

const scaleFor = ( metersPerPixel: number ) => {
  const maxMeters = metersPerPixel * MAX_BAR_WIDTH;
  let unitMeters: number;
  let unit: string;
  if ( usesMetricSystem( ) ) {
    [unitMeters, unit] = maxMeters >= 1000
      ? [1000, "km"]
      : [1, "m"];
  } else {
    [unitMeters, unit] = maxMeters >= METERS_PER_MILE
      ? [METERS_PER_MILE, "mi"]
      : [METERS_PER_FOOT, "ft"];
  }
  const value = niceNumber( maxMeters / unitMeters );
  return { label: `${value} ${unit}`, width: ( value * unitMeters ) / metersPerPixel };
};

interface Props {
  region?: Region | null;
  mapWidth: number;
  className?: string;
}

const ScaleBar = ( { region, mapWidth, className = "absolute left-3 top-12" }: Props ) => {
  if ( !region?.longitudeDelta || !mapWidth ) return null;
  const metersPerPixel = ( region.longitudeDelta * METERS_PER_DEGREE
    * Math.cos( ( region.latitude * Math.PI ) / 180 ) ) / mapWidth;
  if ( !( metersPerPixel > 0 ) ) return null;
  const { label, width } = scaleFor( metersPerPixel );
  return (
    <View
      className={`${className} bg-white/80 rounded px-1.5 py-1`}
      pointerEvents="none"
    >
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <Body4 className="text-black mb-0.5">{label}</Body4>
      <View
        className="h-1 bg-white border border-t-0 border-black"
        style={{ width }}
      />
    </View>
  );
};

export default ScaleBar;
