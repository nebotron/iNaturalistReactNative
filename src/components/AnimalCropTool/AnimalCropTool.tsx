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
  getAnimalCropLogAsArray,
  saveAnimalCrop,
} from "sharedHelpers/animalCropLog";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import {
  defaultSquareCrop,
} from "sharedHelpers/normalizedCropTypes";
import colors from "styles/tailwindColors";

// eslint-disable-next-line i18next/no-literal-string
const BIRD_API_URL = "https://api.inaturalist.org/v1/observations"
  + "?taxon_id=3&photos=true&order_by=random&per_page=20&quality_grade=research";
// eslint-disable-next-line i18next/no-literal-string
const ANIMAL_API_URL = "https://api.inaturalist.org/v1/observations"
  + "?taxon_id=1&photos=true&order_by=random&per_page=20&quality_grade=research";

const CROP_FRAME_PADDING = 0.045;
const LOW_POOL_THRESHOLD = 5;

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
  const results = ( data as { results?: unknown[] } ).results ?? [];
  return results.flatMap( obs => {
    const obsPhotos = ( obs as { observation_photos?: unknown[] } ).observation_photos ?? [];
    const first = obsPhotos[0] as { photo?: { url?: string } } | undefined;
    if ( !first ) return [];
    const { url } = first.photo ?? {};
    return url
      ? [{ squareUrl: url, largeUrl: url.replace( /square/i, "large" ) }]
      : [];
  } );
};

const AnimalCropTool = ( ) => {
  const [birdPool, setBirdPool] = useState<RemotePhoto[]>( [] );
  const [animalPool, setAnimalPool] = useState<RemotePhoto[]>( [] );
  const [currentPhoto, setCurrentPhoto] = useState<RemotePhoto | null>( null );
  const [localPhoto, setLocalPhoto] = useState<LocalPhoto | null>( null );
  const [savedCount, setSavedCount] = useState( getAnimalCropCount );

  // Alternates which pool to draw from; randomise the starting side
  const nextIsBirdRef = useRef( Math.random() < 0.5 );
  const fetchingBirdRef = useRef( false );
  const fetchingAnimalRef = useRef( false );
  // Tracks every URL we have shown or already labelled so we never repeat
  const seenUrlsRef = useRef<Set<string>>( new Set() );

  // Pre-populate seenUrls from the persisted crop log
  useEffect( ( ) => {
    for ( const entry of getAnimalCropLogAsArray( ) ) {
      seenUrlsRef.current.add( entry.url );
    }
  }, [] );

  const fetchBirds = useCallback( ( ) => {
    if ( fetchingBirdRef.current ) return;
    fetchingBirdRef.current = true;
    fetch( BIRD_API_URL )
      .then( r => r.json( ) )
      .then( data => {
        const fresh = parsePhotos( data )
          .filter( p => !seenUrlsRef.current.has( p.largeUrl ) );
        setBirdPool( prev => [...prev, ...fresh] );
      } )
      .catch( ( ) => Alert.alert( "Error", "Could not load bird photos" ) )
      .finally( ( ) => { fetchingBirdRef.current = false; } );
  }, [] );

  const fetchAnimals = useCallback( ( ) => {
    if ( fetchingAnimalRef.current ) return;
    fetchingAnimalRef.current = true;
    fetch( ANIMAL_API_URL )
      .then( r => r.json( ) )
      .then( data => {
        const fresh = parsePhotos( data )
          .filter( p => !seenUrlsRef.current.has( p.largeUrl ) );
        setAnimalPool( prev => [...prev, ...fresh] );
      } )
      .catch( ( ) => Alert.alert( "Error", "Could not load animal photos" ) )
      .finally( ( ) => { fetchingAnimalRef.current = false; } );
  }, [] );

  // Initial fetch
  useEffect( ( ) => {
    fetchBirds( );
    fetchAnimals( );
  }, [fetchBirds, fetchAnimals] );

  // Keep pools topped up
  useEffect( ( ) => {
    if ( birdPool.length < LOW_POOL_THRESHOLD ) fetchBirds( );
  }, [birdPool.length, fetchBirds] );

  useEffect( ( ) => {
    if ( animalPool.length < LOW_POOL_THRESHOLD ) fetchAnimals( );
  }, [animalPool.length, fetchAnimals] );

  // Pick the next photo whenever current is cleared, alternating bird/animal
  useEffect( ( ) => {
    if ( currentPhoto !== null ) return;

    const hasBird = birdPool.length > 0;
    const hasAnimal = animalPool.length > 0;
    if ( !hasBird && !hasAnimal ) return; // still loading

    const wantBird = nextIsBirdRef.current;
    const useBird = ( wantBird && hasBird ) || !hasAnimal;
    // Next pick is the opposite of what we just showed
    nextIsBirdRef.current = !useBird;

    if ( useBird ) {
      setCurrentPhoto( birdPool[0] );
      setBirdPool( p => p.slice( 1 ) );
    } else {
      setCurrentPhoto( animalPool[0] );
      setAnimalPool( p => p.slice( 1 ) );
    }
  }, [currentPhoto, birdPool, animalPool] );

  // Download the current photo for display
  useEffect( ( ) => {
    if ( !currentPhoto || localPhoto?.largeUrl === currentPhoto.largeUrl ) {
      return;
    }

    let cancelled = false;
    setLocalPhoto( null );

    ( async ( ) => {
      try {
        const uri = await ensureLocalImageForCrop( currentPhoto.squareUrl );
        const size = await new Promise<{ w: number; h: number }>( ( resolve, reject ) => {
          RNImage.getSize( uri, ( w, h ) => resolve( { w, h } ), reject );
        } );
        if ( !cancelled ) {
          setLocalPhoto( { largeUrl: currentPhoto.largeUrl, localUri: uri, ...size } );
        }
      } catch {
        if ( !cancelled ) {
          seenUrlsRef.current.add( currentPhoto.largeUrl );
          setCurrentPhoto( null );
        }
      }
    } )( );

    // eslint-disable-next-line consistent-return
    return ( ) => { cancelled = true; };
  }, [currentPhoto, localPhoto?.largeUrl] );

  const advance = useCallback( ( ) => {
    if ( currentPhoto ) seenUrlsRef.current.add( currentPhoto.largeUrl );
    setCurrentPhoto( null );
    setLocalPhoto( null );
  }, [currentPhoto] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ): Promise<void> => {
    if ( localPhoto ) {
      saveAnimalCrop( localPhoto.largeUrl, crop );
      setSavedCount( c => c + 1 );
    }
    advance( );
    return Promise.resolve( );
  }, [localPhoto, advance] );

  if ( !localPhoto || localPhoto.largeUrl !== currentPhoto?.largeUrl ) {
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
