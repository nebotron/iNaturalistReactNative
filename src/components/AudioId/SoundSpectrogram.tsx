import { View } from "components/styledComponents";
import React, { useEffect, useState } from "react";

import AudioClipSpectrogram from "./AudioClipSpectrogram";
import { AudioBirdId, normalizedSoundUri } from "./audioIdSession";

// Every spectrogram a sound plays under is this tall, so they all look alike.
export const SPECTROGRAM_HEIGHT = 140;
const SPECTROGRAM_STYLE = { height: SPECTROGRAM_HEIGHT };

// The spectrogram of the sound at `uri` (a file path, file URL or remote URL).
// The native view reads a local file, so other sounds go through the same
// cached copy the players use. Where there's no native view (Android), or
// until the copy is ready, it's an empty box of the same size.
const SoundSpectrogram = ( { uri }: { uri: string } ) => {
  // The local copy, with the uri it's of, so a stale one is never shown
  const [copy, setCopy] = useState<{ of: string; path: string }>( );
  const isLocal = uri.startsWith( "/" );
  useEffect( ( ) => {
    let cancelled = false;
    if ( AudioBirdId && !isLocal ) {
      normalizedSoundUri( uri ).then( local => {
        if ( !cancelled && local.startsWith( "file://" ) ) {
          setCopy( { of: uri, path: decodeURIComponent( local.replace( /^file:\/\//, "" ) ) } );
        }
      } );
    }
    return ( ) => { cancelled = true; };
  }, [uri, isLocal] );
  let path: string | undefined;
  if ( AudioBirdId ) {
    path = isLocal
      ? uri
      : ( copy?.of === uri && copy.path ) || undefined;
  }
  return path
    ? <AudioClipSpectrogram path={path} style={SPECTROGRAM_STYLE} pointerEvents="none" />
    : <View style={SPECTROGRAM_STYLE} className="bg-black" pointerEvents="none" />;
};

export default SoundSpectrogram;
