import { Body3 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

// Progress of downloading every observation that taxonomic order is about to sort
const TaxonomicFetchNotice = ( ) => {
  const { t } = useTranslation( );
  const taxonomicFetch = useStore( state => state.taxonomicFetch );
  if ( !taxonomicFetch ) return null;
  return (
    <View className="px-4 py-2" testID="TaxonomicFetchNotice">
      <Body3>
        {t( "Downloading-observations-to-sort-fetched-of-total", {
          fetched: taxonomicFetch.fetched,
          total: taxonomicFetch.total,
        } )}
      </Body3>
    </View>
  );
};

export default TaxonomicFetchNotice;
