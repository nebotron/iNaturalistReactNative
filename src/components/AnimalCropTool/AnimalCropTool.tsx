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
import detectSubjectInImage from "sharedHelpers/detectSubjectInImage";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
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
  const [initialCrop, setInitialCrop] = useState<NormalizedCrop | null>( null );
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
        const photos = parsePhotos( data );
        setBirdPool( prev => {
          const existingUrls = new Set( prev.map( p => p.largeUrl ) );
          const fresh = photos.filter(
            p => !seenUrlsRef.current.has( p.largeUrl )
              && !existingUrls.has( p.largeUrl ),
          );
          return [...prev, ...fresh];
        } );
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
        const photos = parsePhotos( data );
        setAnimalPool( prev => {
          const existingUrls = new Set( prev.map( p => p.largeUrl ) );
          const fresh = photos.filter(
            p => !seenUrlsRef.current.has( p.largeUrl )
              && !existingUrls.has( p.largeUrl ),
          );
          return [...prev, ...fresh];
        } );
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

    const unseenBird = birdPool.find( p => !seenUrlsRef.current.has( p.largeUrl ) );
    const unseenAnimal = animalPool.find( p => !seenUrlsRef.current.has( p.largeUrl ) );
    if ( !unseenBird && !unseenAnimal ) return; // still loading

    const wantBird = nextIsBirdRef.current;
    const useBird = ( wantBird && !!unseenBird ) || !unseenAnimal;
    // Next pick is the opposite of what we just showed
    nextIsBirdRef.current = !useBird;

    const picked = useBird
      ? unseenBird!
      : unseenAnimal!;
    setCurrentPhoto( picked );
    if ( useBird ) {
      setBirdPool( p => p.filter( p2 => p2.largeUrl !== picked.largeUrl ) );
    } else {
      setAnimalPool( p => p.filter( p2 => p2.largeUrl !== picked.largeUrl ) );
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

  // Run subject detection once the local image is ready
  useEffect( ( ) => {
    if ( !localPhoto ) return;
    let cancelled = false;
    setInitialCrop( null );
    ( async ( ) => {
      const crop = await detectSubjectInImage(
        localPhoto.localUri,
        localPhoto.w,
        localPhoto.h,
      );
      if ( !cancelled ) setInitialCrop( crop );
    } )( );
    // eslint-disable-next-line consistent-return
    return ( ) => { cancelled = true; };
  }, [localPhoto] );

  const advance = useCallback( ( ) => {
    if ( currentPhoto ) seenUrlsRef.current.add( currentPhoto.largeUrl );
    setCurrentPhoto( null );
    setLocalPhoto( null );
    setInitialCrop( null );
  }, [currentPhoto] );

  const handleConfirm = useCallback( ( crop: NormalizedCrop ): Promise<void> => {
    if ( localPhoto ) {
      saveAnimalCrop( localPhoto.largeUrl, crop );
      setSavedCount( c => c + 1 );
    }
    advance( );
    return Promise.resolve( );
  }, [localPhoto, advance] );

  if ( !localPhoto || localPhoto.largeUrl !== currentPhoto?.largeUrl || !initialCrop ) {
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
      initialCrop={initialCrop}
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
