import { Body3 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  kind: "observations" | "species";
  loaded: number;
  limit: number;
  total: number | null | undefined;
}

// Explore sorts taxonomically on device, so it first loads as many results as it sorts, and
// can only sort the first `limit` of a bigger search
const TaxonomicOrderNotice = ( {
  kind, loaded, limit, total,
}: Props ) => {
  const { t } = useTranslation( );
  if ( typeof total !== "number" || total === 0 ) return null;
  const target = Math.min( total, limit );
  let text: string | null = null;
  if ( loaded < target ) {
    text = kind === "observations"
      ? t( "Loading-observations-to-sort-loaded-of-total", { loaded, total: target } )
      : t( "Loading-species-to-sort-loaded-of-total", { loaded, total: target } );
  } else if ( total > limit ) {
    text = kind === "observations"
      ? t( "Taxonomic-order-covers-the-1000-most-recently-added-observations" )
      : t( "Taxonomic-order-covers-the-2000-most-observed-species" );
  }
  if ( !text ) return null;
  return (
    <View className="px-4 py-2" testID="TaxonomicOrderNotice">
      <Body3>{text}</Body3>
    </View>
  );
};

export default TaxonomicOrderNotice;
