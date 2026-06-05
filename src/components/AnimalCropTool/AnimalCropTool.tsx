import ImageCropView from "components/SharedComponents/ImageCrop/ImageCropView";
import { Text, View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Image as RNImage,
} from "react-native";
import {
  getAnimalCropCount,
  saveAnimalCrop,
} from "sharedHelpers/animalCropLog";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import {
  defaultSquareCrop,
  type NormalizedCrop,
} from "sharedHelpers/normalizedCropTypes";
import colors from "styles/tailwindColors";

// eslint-disable-next-line i18next/no-literal-string
const API_URL = "https://api.inaturalist.org/v1/observations"
  + "?taxon_id=1&photos=true&order_by=random&per_page=20&quality_grade=research";

const CROP_FRAME_PADDING = 0.045;

interface RemotePhoto {
  squareUrl: string;
  largeUrl: string;
}

interface LocalPhoto {
  largeUrl: string;
  localUri: string;
  w: number;
  h: number;
}

const parsePhotos = ( data: unknown ): RemotePhoto[] => {
  const photos: RemotePhoto[] = [];
  const results = ( data as { results?: unknown[] } ).results ?? [];
  for ( const obs of results ) {
    const obsPhotos = ( obs as { observation_photos?: unknown[] } ).observation_photos ?? [];
    const first = obsPhotos[0];
    if ( !first ) continue;
    const url = ( ( first as { photo?: { url?: string } } ).photo ?? {} ).url;
    if ( url ) {
      photos.push( { squareUrl: url, largeUrl: url.replace( /square/i, "large" ) } );
    }
  }
  return photos;
};

const AnimalCropTool = ( ) => {
  const [queue, setQueue] = useState<RemotePhoto[]>( [] );
  const [idx, setIdx] = useState( 0 );
  const [localPhoto, setLocalPhoto] = useState<LocalPhoto | null>( null );
  const [savedCount, setSavedCount] = useState( getAnimalCropCount );
  const fetchingRef = useRef( false );

  const fetchMore = useCallback( ( ) => {
    if ( fetchingRef.current ) return;
    fetchingRef.current = true;
    fetch( API_URL )
      .then( r => r.json( ) )
      .then( data => {
        setQueue( prev => [...prev, ...parsePhotos( data )] );
      } )
      .catch( ( ) => Alert.alert( "Error", "Could not load animal photos" ) )
      .finally( ( ) => { fetchingRef.current = false; } );
  }, [] );

  useEffect( ( ) => { fetchMore( ); }, [fetchMore] );

  useEffect( ( ) => {
    if ( queue.length - idx < 5 ) fetchMore( );
  }, [idx, queue.length, fetchMore] );

  const currentTarget = queue[idx] ?? null;

  useEffect( ( ) => {
    if ( !currentTarget || localPhoto?.largeUrl === currentTarget.largeUrl ) return;

    let cancelled = false;
    setLocalPhoto( null );

    ( async ( ) => {
      try {
        const uri = await ensureLocalImageForCrop( currentTarget.squareUrl );
        const size = await new Promise<{ w: number; h: number }>( ( resolve, reject ) => {
          RNImage.getSize( uri, ( w, h ) => resolve( { w, h } ), reject );
        } );
        if ( !cancelled ) {
          setLocalPhoto( { largeUrl: currentTarget.largeUrl, localUri: uri, ...size } );
        }
      } catch {
        if ( !cancelled ) setIdx( i => i + 1 );
      }
    } )( );

    return ( ) => { cancelled = true; };
  }, [currentTarget, localPhoto?.largeUrl] );

  const advance = useCallback( ( ) => {
    setIdx( i => i + 1 );
    setLocalPhoto( null );
  }, [] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ): Promise<void> => {
    if ( localPhoto ) {
      saveAnimalCrop( localPhoto.largeUrl, crop );
      setSavedCount( c => c + 1 );
    }
    advance( );
    return Promise.resolve( );
  }, [localPhoto, advance] );

  if ( !localPhoto || localPhoto.largeUrl !== currentTarget?.largeUrl ) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator color={colors.white} size="large" />
        {savedCount > 0 && (
          // eslint-disable-next-line i18next/no-literal-string
          <Text className="mt-4 text-white">{`${savedCount} saved`}</Text>
        )}
      </View>
    );
  }

  return (
    <ImageCropView
      sourceUri={localPhoto.localUri}
      imageWidth={localPhoto.w}
      imageHeight={localPhoto.h}
      framePadding={CROP_FRAME_PADDING}
      initialCrop={defaultSquareCrop( localPhoto.w, localPhoto.h )}
      labels={{
        // eslint-disable-next-line i18next/no-literal-string
        confirm: "Save",
        // eslint-disable-next-line i18next/no-literal-string
        delete: "Skip",
        // eslint-disable-next-line i18next/no-literal-string
        instructions: `${savedCount} saved — crop to subject`,
      }}
      onConfirm={handleConfirm}
      onDelete={advance}
    />
  );
};

export default AnimalCropTool;
