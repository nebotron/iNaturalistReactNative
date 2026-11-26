import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { NavigationContext, NavigationRouteContext } from "@react-navigation/native";
import { useContext, useEffect } from "react";

type Navigation = NavigationProp<ParamListBase>;

// How many mounted controls currently need each screen's swipe-back off.
const blockers = new Map<string, number>( );

const indexOfRoute = ( nav: Navigation, key: string ) => {
  const { routes } = nav.getState( );
  return routes.findIndex( route => route.key === key );
};

// Key of the parent's route that holds the navigator `nav` belongs to.
const keyOfNavigator = ( parent: Navigation, nav: Navigation ) => {
  const navigatorKey = nav.getState( ).key;
  return parent.getState( ).routes
    .find( route => route.state?.key === navigatorKey )?.key;
};

// The screen whose stack would pop on an edge swipe: the nearest screen, from
// this one outward, that isn't its stack's first. The root stack is skipped,
// since it never allows swiping back.
const findSwipeableScreen = (
  navigation: Navigation | undefined,
  routeKey: string | undefined,
): { screen: Navigation; key: string } | null => {
  let nav = navigation;
  let key = routeKey;
  while ( nav && key ) {
    const parent = nav.getParent( );
    if ( !parent ) return null;
    if ( nav.getState( ).type === "stack" && indexOfRoute( nav, key ) > 0 ) {
      return { screen: nav, key };
    }
    key = keyOfNavigator( parent, nav );
    nav = parent;
  }
  return null;
};

// Turns off the swipe-back gesture while a horizontal drag control (a slider
// or scrubber) is on screen, where a sideways drag would be ambiguous.
const usePreventSwipeBack = ( active = true ) => {
  const navigation = useContext( NavigationContext );
  const route = useContext( NavigationRouteContext );
  const routeKey = route?.key;

  useEffect( ( ) => {
    const found = active
      ? findSwipeableScreen( navigation, routeKey )
      : null;
    if ( !found ) return ( ) => undefined;
    const { screen, key } = found;
    const count = blockers.get( key ) || 0;
    blockers.set( key, count + 1 );
    if ( count === 0 ) screen.setOptions( { gestureEnabled: false } );
    return ( ) => {
      const remaining = ( blockers.get( key ) || 1 ) - 1;
      if ( remaining > 0 ) {
        blockers.set( key, remaining );
      } else {
        blockers.delete( key );
        screen.setOptions( { gestureEnabled: true } );
      }
    };
  }, [active, navigation, routeKey] );
};

export default usePreventSwipeBack;
