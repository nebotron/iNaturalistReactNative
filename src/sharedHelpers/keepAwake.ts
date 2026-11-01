import { activateKeepAwake, deactivateKeepAwake } from "@sayem314/react-native-keep-awake";

// The native keep-awake is one on/off flag, so two features toggling it
// directly cut each other off or leave it on. Each holder is tracked here, and
// the screen may sleep once none remain.
const holders = new Set<string>( );

export const holdKeepAwake = ( holder: string ) => {
  holders.add( holder );
  activateKeepAwake( );
};

export const releaseKeepAwake = ( holder: string ) => {
  holders.delete( holder );
  if ( holders.size === 0 ) deactivateKeepAwake( );
};
