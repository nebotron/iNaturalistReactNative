import type { ExploreUserFilter } from "components/Explore/helpers/userFilters";
import { toggleUserFilter } from "components/Explore/helpers/userFilters";
import {
  Button,
  Heading4,
  INatIconButton,
} from "components/SharedComponents";
import UserListItem from "components/UserList/UserListItem";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  onOpenUserSearch: () => void;
  userFilters: ExploreUserFilter[];
  updateUserFilters: ( userFilters: ExploreUserFilter[] ) => void;
}

const ExploreUserFiltersSection = ( {
  onOpenUserSearch,
  userFilters,
  updateUserFilters,
}: Props ) => {
  const { t } = useTranslation( );
  const hasUserFilters = userFilters.length > 0;

  const removeFilter = ( userId: number ) => {
    updateUserFilters( userFilters.filter( filter => filter.user.id !== userId ) );
  };

  return (
    <View className="mb-7">
      <Heading4 className="mb-5">{t( "USER" )}</Heading4>
      <View className="mb-5">
        {hasUserFilters
          ? (
            <View>
              {userFilters.map( filter => (
                <View
                  key={`user-filter-${filter.user.id}-${filter.exclude}`}
                  className="flex-row justify-between items-center mb-5"
                >
                  <View className="flex-1 mr-3">
                    <UserListItem
                      item={{ user: filter.user }}
                      countText={filter.user.observations_count != null
                        ? t( "X-Observations", { count: filter.user.observations_count } )
                        : undefined}
                      pressable={false}
                    />
                  </View>
                  <View className="flex-row items-center">
                    <Button
                      level={filter.exclude
                        ? "neutral"
                        : "focus"}
                      text={filter.exclude
                        ? t( "Exclude-user" )
                        : t( "Include-user" )}
                      onPress={() => updateUserFilters(
                        toggleUserFilter( userFilters, filter.user, !filter.exclude ),
                      )}
                      className="mr-2 shrink"
                    />
                    <INatIconButton
                      icon="close"
                      size={20}
                      onPress={() => removeFilter( filter.user.id )}
                      accessibilityLabel={t( "Remove-user-filter" )}
                    />
                  </View>
                </View>
              ) )}
              <Button
                text={t( "ADD-USER-FILTER" )}
                onPress={onOpenUserSearch}
                accessibilityLabel={t( "Search" )}
              />
            </View>
          )
          : (
            <Button
              text={t( "FILTER-BY-A-USER" )}
              onPress={onOpenUserSearch}
              accessibilityLabel={t( "Filter" )}
            />
          )}
      </View>
    </View>
  );
};

export default ExploreUserFiltersSection;
