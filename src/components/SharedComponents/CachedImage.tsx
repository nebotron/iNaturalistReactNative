import classnames from "classnames";
import { FasterImageView, Image, View } from "components/styledComponents";
import React, { useCallback, useEffect, useState } from "react";
import type {
  ImageSourcePropType,
  StyleProp,
  ViewStyle,
} from "react-native";
import { NativeModules, StyleSheet } from "react-native";

// Every remote image in the app loads through this one policy, so they all
// share a single on-disk cache.
//
// iNaturalist media URLs are immutable: the numeric id in the path changes
// whenever the underlying photo does, so a URL never needs revalidating. The
// CDN sends no Cache-Control and no Expires though, which leaves an HTTP cache
// guessing at freshness from Last-Modified — roughly 10% of the file's age, so
// a photo uploaded minutes ago goes stale almost immediately and revalidates
// on nearly every render, and misses outright when offline.
// "discNoCacheControl" skips HTTP semantics entirely and keeps the bytes in
// Nuke's DataCache until iOS reclaims them.
export const IMMUTABLE_CACHE_POLICY = "discNoCacheControl";

export type CachedImageResizeMode = "cover" | "contain" | "center" | "fill";

interface Props {
  accessibilityIgnoresInvertColors?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "image";
  children?: React.ReactNode;
  className?: string;
  onError?: ( ) => void;
  onLoad?: ( dimensions: { width: number; height: number } ) => void;
  // React Native's <Image> defaults to "cover" while FasterImageView defaults
  // to "contain". Match <Image> so this drops into existing call sites.
  resizeMode?: CachedImageResizeMode;
  source?: ImageSourcePropType | { uri?: string | null } | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  // Seconds to fade a newly loaded image in over. FasterImageView defaults to
  // 0.5 and only skips the fade for memory-cache hits, so every disk-cache hit
  // would fade; <Image> never fades, so default to matching it.
  transitionDuration?: number;
}

const remoteUriFor = ( source: Props["source"] ): string | null => {
  if ( !source || typeof source !== "object" || Array.isArray( source ) ) return null;
  const { uri } = source as { uri?: string | null };
  // Only http(s) goes to the network. file://, ph:// and asset-library:// URIs
  // are already on disk, and FasterImageView can't resolve PHAsset ids at all.
  return typeof uri === "string" && /^https?:\/\//i.test( uri )
    ? uri
    : null;
};

// iNaturalist photo sizes, smallest first. They share a URL apart from the
// size segment, e.g. .../photos/123/large.jpg.
const PHOTO_SIZES = ["square", "small", "medium", "large", "original"];
const PHOTO_SIZE_REGEX = /\/(square|small|medium|large|original)\.(jpe?g|png|gif)/i;

// Smaller variants of a large or original iNaturalist photo URL, largest
// first. Thumbnails load fast enough not to need a placeholder.
const smallerVariants = ( uri: string ): string[] => {
  const match = uri.match( PHOTO_SIZE_REGEX );
  const index = match
    ? PHOTO_SIZES.indexOf( match[1].toLowerCase( ) )
    : -1;
  if ( index < PHOTO_SIZES.indexOf( "large" ) ) return [];
  return PHOTO_SIZES.slice( 0, index ).reverse( ).map(
    size => uri.replace( PHOTO_SIZE_REGEX, `/${size}.$2` ),
  );
};

// The largest smaller variant of `remoteUri` that is already cached, to show
// while `remoteUri` itself downloads. Never fetches anything new.
const useCachedPlaceholder = ( remoteUri: string | null ) => {
  const [placeholder, setPlaceholder] = useState<{ for: string; uri: string } | null>( null );
  useEffect( ( ) => {
    const cachedSources = NativeModules.FasterImageViewManager?.cachedSources;
    const variants = remoteUri
      ? smallerVariants( remoteUri )
      : [];
    let cancelled = false;
    if ( remoteUri && cachedSources && variants.length > 0 ) {
      cachedSources( variants ).then( ( cached: string[] ) => {
        const best = variants.find( variant => cached.includes( variant ) );
        if ( !cancelled && best ) setPlaceholder( { for: remoteUri, uri: best } );
      } ).catch( ( ) => null );
    }
    return ( ) => {
      cancelled = true;
    };
  }, [remoteUri] );
  return placeholder?.for === remoteUri
    ? placeholder.uri
    : null;
};

/**
 * The single image component for anything that might load over the network.
 *
 * Sizing, spacing and corner radius go on a wrapping View rather than on the
 * image itself: FasterImageView is a native view that takes its corner radius
 * through the source object instead of through style, so clipping on the
 * wrapper is the one approach that behaves identically for both backends.
 */
const CachedImage = ( {
  accessibilityIgnoresInvertColors = true,
  accessibilityLabel,
  accessibilityRole,
  children,
  className,
  onError,
  onLoad,
  resizeMode = "cover",
  source,
  style,
  testID,
  transitionDuration = 0,
}: Props ) => {
  const remoteUri = remoteUriFor( source );
  const placeholderUri = useCachedPlaceholder( remoteUri );
  const [loadedUri, setLoadedUri] = useState<string | null>( null );

  const handleFasterImageSuccess = useCallback( ( event: {
    nativeEvent: { width: number; height: number };
  } ) => {
    setLoadedUri( remoteUri );
    const { width, height } = event.nativeEvent;
    onLoad?.( { width, height } );
  }, [onLoad, remoteUri] );

  const handleImageLoad = useCallback( ( event: {
    nativeEvent: { source: { width: number; height: number } };
  } ) => {
    const { width, height } = event.nativeEvent.source;
    onLoad?.( { width, height } );
  }, [onLoad] );

  return (
    <View
      className={classnames( "overflow-hidden", className )}
      style={style}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {placeholderUri && loadedUri !== remoteUri && (
        <FasterImageView
          key={placeholderUri}
          style={StyleSheet.absoluteFill}
          accessibilityIgnoresInvertColors={accessibilityIgnoresInvertColors}
          source={{
            url: placeholderUri,
            cachePolicy: IMMUTABLE_CACHE_POLICY,
            resizeMode,
            transitionDuration: 0,
          }}
        />
      )}
      {remoteUri
        ? (
          <FasterImageView
            // Without a key the native view keeps showing the previous image
            // until the new one resolves, which shows the wrong photo in
            // recycled list cells.
            key={remoteUri}
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors={accessibilityIgnoresInvertColors}
            source={{
              url: remoteUri,
              cachePolicy: IMMUTABLE_CACHE_POLICY,
              resizeMode,
              transitionDuration,
            }}
            onSuccess={onLoad || placeholderUri
              ? handleFasterImageSuccess
              : undefined}
            onError={onError}
          />
        )
        : source && (
          <Image
            style={StyleSheet.absoluteFill}
            accessibilityIgnoresInvertColors={accessibilityIgnoresInvertColors}
            source={source as ImageSourcePropType}
            // FasterImageView calls it "fill"; <Image> calls it "stretch".
            resizeMode={resizeMode === "fill"
              ? "stretch"
              : resizeMode}
            onLoad={onLoad
              ? handleImageLoad
              : undefined}
            onError={onError}
          />
        )}
      {children}
    </View>
  );
};

export default CachedImage;
