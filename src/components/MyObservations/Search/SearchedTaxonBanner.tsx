import {
  Body3,
  CachedImage,
  IconicTaxonIcon,
  INatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import {
  MY_OBSERVATIONS_ACTION,
  useMyObservations,
} from "providers/MyObservationsContext";
import React from "react";
import { taxonDisplayName } from "sharedHelpers/taxon";
import { useCurrentUser, useTranslation } from "sharedHooks";

interface Props {
  onBack: ( ) => void;
}

const SearchedTaxonBanner = ( { onBack }: Props ) => {
  const { t } = useTranslation( );
  const { state, dispatch } = useMyObservations( );
  const { searchedTaxon, previousTaxonSearch } = state;

  const currentUser = useCurrentUser( );

  if ( !searchedTaxon ) return null;

  const displayName = taxonDisplayName( searchedTaxon, currentUser );

  return (
    <View
      className="flex-row items-center bg-white gap-x-[20px]"
      testID="SearchedTaxonBanner"
    >
      <View className="flex-1 flex-row items-center gap-x-[10px]">
        {previousTaxonSearch && (
          <INatIconButton
            icon="chevron-left"
            size={14}
            accessibilityLabel={t( "Go-back" )}
            onPress={( ) => {
              dispatch( { type: MY_OBSERVATIONS_ACTION.RESTORE_PREVIOUS_TAXON_SEARCH } );
              onBack( );
            }}
          />
        )}
        <View className="w-[44px] h-[44px] bg-lightGray">
          {searchedTaxon.iconUri
            ? (
              <CachedImage
                source={{ uri: searchedTaxon.iconUri }}
                className="w-full h-full"
              />
            )
            : (
              <IconicTaxonIcon
                iconicTaxonName={searchedTaxon.iconicTaxonName}
                imageClassName={["w-full", "h-full"]}
                isBackground
                size={24}
              />
            )}
        </View>
        <Body3 className="flex-1" numberOfLines={1}>
          {displayName}
        </Body3>
      </View>
      <INatIconButton
        icon="close"
        size={14}
        accessibilityLabel={t( "Close-search" )}
        onPress={( ) => dispatch( {
          type: MY_OBSERVATIONS_ACTION.CLEAR_TAXON_SEARCH,
        } )}
      />
    </View>
  );
};

export default SearchedTaxonBanner;
