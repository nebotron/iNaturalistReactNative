import defaultSavedSearches from "components/Explore/ExploreV2/helpers/defaultSavedSearches";
import { useEffect } from "react";
import useTranslation from "sharedHooks/useTranslation";
import useStore from "stores/useStore";

interface User {
  id: number;
  login: string;
  icon_url?: string;
}

// Gives each user the starter saved searches the first time they're signed in on this
// device. A fresh install has no user to search for until then.
const useDefaultSavedSearches = ( currentUser?: User | null ) => {
  const { t } = useTranslation( );
  const addDefaultSearches = useStore( state => state.exploreSavedSearches.addDefaultSearches );
  const added = useStore( state => (
    !!currentUser?.id
    && state.exploreSavedSearches.defaultsAddedForUserIds.includes( currentUser.id )
  ) );
  const userId = currentUser?.id;
  const login = currentUser?.login;
  const iconUrl = currentUser?.icon_url;

  useEffect( ( ) => {
    if ( !userId || !login || added ) return;
    // Translation can fail on first launch; try again on a later render
    if ( !t( "My-species" ) ) return;
    addDefaultSearches(
      userId,
      defaultSavedSearches( { id: userId, login, icon_url: iconUrl }, t ),
    );
  }, [addDefaultSearches, added, iconUrl, login, t, userId] );
};

export default useDefaultSavedSearches;
