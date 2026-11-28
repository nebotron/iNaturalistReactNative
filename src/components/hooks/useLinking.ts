import { CommonActions, useNavigation } from "@react-navigation/native";
import {
  searchObservations,
} from "api/observations";
import { fetchTaxaBasics } from "api/taxa";
import { fetchRemoteUser } from "api/users";
import { normalizeTaxonFilters } from "components/Explore/helpers/taxonFilters";
import { resultToSubject } from "components/Explore/helpers/universalSearchSubject";
import type { ExploreLink } from "components/hooks/exploreLink";
import { parseExploreLink } from "components/hooks/exploreLink";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import navigateToObsDetails from "components/ObsDetails/helpers/navigateToObsDetails";
import { DATE_OBSERVED } from "providers/ExploreContext";
import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import type { UserPojo } from "realmModels/User";
import useStore from "stores/useStore";

const newAccountConfirmedUrl = "https://www.inaturalist.org/users/sign_in?confirmed=true";
const existingAccountConfirmedUrl = "https://www.inaturalist.org/home?confirmed=true";

const useLinking = ( currentUser: UserPojo | null ) => {
  const navigation = useNavigation( );
  const [observationId, setObservationId] = useState<string | null>( null );

  const navigateConfirmedUser = useCallback( ( ) => {
    if ( currentUser ) { return; }
    navigation.navigate( "LoginStackNavigator", {
      screen: "Login",
      params: { emailConfirmed: true },
    } );
  }, [navigation, currentUser] );

  const navigateToObservations = useCallback( async ( ) => {
    const searchParams = { id: observationId };
    const apiToken = await getJWT( );
    const options = {
      api_token: apiToken,
    };
    const { results } = await searchObservations( searchParams, options );
    const uuid = results?.[0]?.uuid;

    if ( uuid ) {
      navigateToObsDetails( navigation, uuid );
      // ObsId reset for the case the same link is pressed twice and the obsId is the same
      setObservationId( null );
    }
  }, [navigation, observationId] );

  // Opens Explore on the link's search. Waits for the user and taxa so the
  // search's header shows their names, as when they're picked in the app
  const navigateToExplore = useCallback( async ( link: ExploreLink ) => {
    const [user, taxa] = await Promise.all( [
      link.userLogin
        ? fetchRemoteUser( link.userLogin )
        : null,
      link.taxonIds.length > 0
        ? fetchTaxaBasics( link.taxonIds )
        : [],
    ] );
    if ( link.route.length >= 2 ) {
      useStore.getState( ).layout.setHotspotStops( link.route.map( ( point, index ) => ( {
        id: `link-${index}`,
        text: `${point.latitude}, ${point.longitude}`,
        point,
      } ) ) );
    }
    const params = {
      ...( user && { subject: resultToSubject( { type: "user", user } ) } ),
      ...( link.view && { activeTab: link.view } ),
      filters: {
        taxonFilters: normalizeTaxonFilters( ( taxa || [] ).map( taxon => ( {
          taxon,
          exclude: false,
        } ) ) ),
        ...( ( link.d1 || link.d2 ) && {
          dateObserved: DATE_OBSERVED.DATE_RANGE,
          d1: link.d1,
          d2: link.d2,
        } ),
      },
    };
    // A reset rather than a navigate: Explore reads its search only when it
    // mounts, so a second link would otherwise land on the first one's search
    navigation.dispatch( CommonActions.reset( {
      index: 0,
      routes: [{
        name: "TabNavigator",
        state: {
          routes: [{
            name: "ExploreTab",
            state: {
              index: 1,
              routes: [{ name: "RootExplore" }, { name: "Explore", params }],
            },
          }],
        },
      }],
    } ) );
  }, [navigation] );

  const checkAllowedHosts = useCallback( ( url: string | null ) => {
    if ( typeof url !== "string" ) { return; }
    const { host, pathname, search } = new URL( url );

    const allowedHosts = [
      "www.inaturalist.org",
    ];
    const exploreLink = allowedHosts.includes( host ) && parseExploreLink( pathname, search );
    if ( exploreLink ) {
      navigateToExplore( exploreLink );
    } else if ( allowedHosts?.includes( host )
      && pathname.includes( "/observations" ) ) {
      const id = pathname.split( "/" )[2];
      setObservationId( id );
    }
  }, [navigateToExplore] );

  const handleUrl = useCallback( ( url: string | null ) => {
    if ( url === newAccountConfirmedUrl
      || url === existingAccountConfirmedUrl
    ) {
      navigateConfirmedUser( );
    } else {
      checkAllowedHosts( url );
    }
  }, [navigateConfirmedUser, checkAllowedHosts] );

  useEffect( ( ) => {
    // Without the removal below this effect stacked another handler onto the
    // module-level Linking emitter every time handleUrl changed identity, and
    // they lived for the rest of the process.
    const subscription = Linking.addEventListener( "url", ( { url } ) => {
      if ( !url ) { return; }
      handleUrl( url );
    } );
    return ( ) => subscription.remove( );
  }, [handleUrl] );

  useEffect( ( ) => {
    const fetchInitialUrl = async ( ) => {
      const url = await Linking.getInitialURL( );
      handleUrl( url );
    };
    fetchInitialUrl( );
  }, [handleUrl] );

  useEffect( ( ) => {
    if ( observationId ) {
      navigateToObservations( );
    }
  }, [observationId, navigateToObservations] );
};

export default useLinking;
