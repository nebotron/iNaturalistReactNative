import type { ApiPhoto, ApiTaxon } from "api/types";
import classnames from "classnames";
import MediaViewerModal from "components/MediaViewer/MediaViewerModal";
import {
  IconicTaxonIcon,
  PhotoCount,
} from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import compact from "lodash/compact";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useMemo, useState } from "react";
import { Image as RNImage } from "react-native";
import Photo from "realmModels/Photo";
import type { RealmObservationPhoto, RealmPhoto, RealmTaxon } from "realmModels/types";
import { getPreviouslyUploadedDevicePhotoUrisSet } from
  "sharedHelpers/duplicateUploadedDevicePhotos";
import { useTranslation } from "sharedHooks";

interface Props {
  observationUuid?: string;
  representativePhoto?: ApiPhoto;
  taxon?: ApiTaxon | RealmTaxon;
  obsPhotos: RealmObservationPhoto[];
  navToTaxonDetails: ( photo: ApiPhoto | RealmPhoto ) => void;
  hideTaxonPhotos?: boolean;
}

const { useRealm } = RealmContext;

const PhotosSection = ( {
  observationUuid,
  representativePhoto,
  taxon,
  obsPhotos,
  navToTaxonDetails,
  hideTaxonPhotos,
}: Props ) => {
  const { t } = useTranslation( );
  const realm = useRealm( );
  const [displayPortraitLayout, setDisplayPortraitLayout] = useState<boolean | null>( null );
  const [mediaViewerVisible, setMediaViewerVisible] = useState( false );

  const localTaxonPhotos = taxon?.taxonPhotos;
  const observationPhoto = obsPhotos?.[0]?.photo?.url
  || Photo.getLocalPhotoUri( obsPhotos?.[0]?.photo?.localFilePath );

  const taxonPhotos = compact(
    localTaxonPhotos
      ? localTaxonPhotos.map( taxonPhoto => ( { ...taxonPhoto.photo } ) )
      : [taxon?.defaultPhoto],
  );
  // don't show the iconic taxon photo which is a mashup of 9 bestTaxonPhotos
  if ( taxon?.isIconic ) {
    taxonPhotos.splice( 0 );
  }

  // If the representative photo is already included in taxonPhotos, don't add it but move
  // it to the start of the list.
  let firstPhoto;
  if ( representativePhoto && taxonPhotos.some( photo => photo.id === representativePhoto.id ) ) {
    const repPhotoIndex = taxonPhotos.findIndex( photo => photo.id === representativePhoto.id );
    // The first photo to show is the realm version of the representative photo
    firstPhoto = taxonPhotos.splice( repPhotoIndex, 1 )[0];
  } else if ( representativePhoto ) {
    // This is possible because a representative photo can be from a different taxon, e.g. children
    // of common ancestors. In this case, the representative photo is not included in taxonPhotos.
    firstPhoto = { ...representativePhoto, isRepresentativeButOtherTaxon: true };
  }
  // Add the representative photo at the start of the list of taxon bestTaxonPhotos.
  const taxonPhotosWithRepPhoto = compact( [
    firstPhoto,
    ...taxonPhotos,
  ] );
  const bestTaxonPhotos = taxonPhotosWithRepPhoto.slice( 0, 3 );

  const observationPhotos = compact(
    obsPhotos
      ? obsPhotos.map( obsPhoto => obsPhoto.photo )
      : [],
  );

  const hasDuplicateUpload = useMemo( ( ) => {
    const excludeUuid = observationUuid
      ? [observationUuid]
      : [];
    const uploadedDevicePhotoUris = getPreviouslyUploadedDevicePhotoUrisSet(
      realm,
      excludeUuid,
    );

    return obsPhotos.some( obsPhoto => (
      obsPhoto.originalDevicePhotoUri
      && uploadedDevicePhotoUris.has( obsPhoto.originalDevicePhotoUri )
    ) );
  }, [observationUuid, obsPhotos, realm] );

  useEffect( ( ) => {
    const checkImageOrientation = async ( ) => {
      if ( observationPhoto ) {
        const imageDimensions = await RNImage.getSize( observationPhoto );
        if ( imageDimensions.width < imageDimensions.height ) {
          setDisplayPortraitLayout( true );
        } else {
          setDisplayPortraitLayout( false );
        }
      }
    };
    checkImageOrientation( );
  }, [observationPhoto] );

  const getLayoutClasses = ( ) => {
    // Basic layout: no taxon bestTaxonPhotos + obs photo a square
    let containerClass = "flex-row";
    let observationPhotoClass = "w-full h-full";
    let taxonPhotosContainerClass;
    let taxonPhotoClass;
    if ( !hideTaxonPhotos ) {
      // If there is only one taxon photo: obs photo a square,
      // taxon photo a square in the lower right corner of the obs photo
      if ( bestTaxonPhotos.length === 1 ) {
        containerClass = "flex-row relative";
        observationPhotoClass = "w-full h-full";
        taxonPhotosContainerClass = "absolute bottom-0 right-0 w-1/3 h-1/3";
        taxonPhotoClass = "w-full h-full border-l-[3px] border-t-[3px] border-white";
      }
      if ( bestTaxonPhotos.length > 1 ) {
        if ( displayPortraitLayout ) {
          containerClass = "flex-row";
          observationPhotoClass = "w-2/3 h-full pr-[3px]";
          if ( bestTaxonPhotos.length === 2 ) {
            taxonPhotosContainerClass = "flex-col w-1/3 h-full space-y-[3px]";
            taxonPhotoClass = "w-full h-1/2";
          } else {
            taxonPhotosContainerClass = "flex-col w-1/3 h-full space-y-[3px]";
            taxonPhotoClass = "w-full h-1/3";
          }
        } else {
          containerClass = "flex-col";
          observationPhotoClass = "w-full h-2/3 pb-[3px]";
          if ( bestTaxonPhotos.length === 2 ) {
            taxonPhotosContainerClass = "flex-row w-full h-1/3 space-x-[3px]";
            taxonPhotoClass = "w-1/2 h-full";
          } else {
            taxonPhotosContainerClass = "flex-row w-full h-1/3 space-x-[3px]";
            taxonPhotoClass = "w-1/3 h-full";
          }
        }
      }
    }
    return {
      containerClass,
      observationPhotoClass,
      taxonPhotosContainerClass,
      taxonPhotoClass,
    };
  };

  const layoutClasses = getLayoutClasses();

  const renderObservationPhoto = ( ) => (
    <Pressable
      accessibilityRole="button"
      onPress={() => setMediaViewerVisible( true )}
      accessibilityState={{ disabled: false }}
      className={classnames(
        "relative",
        layoutClasses?.observationPhotoClass,
      )}
    >
      <Image
        testID="MatchScreen.ObsPhoto"
        source={{ uri: Photo.displayLargePhoto( observationPhoto ) }}
        className="w-full h-full"
        accessibilityIgnoresInvertColors
      />
      {observationPhotos.length > 1 && (
        <View className="absolute bottom-5 left-5">
          <PhotoCount count={observationPhotos.length} />
        </View>
      )}
      {hasDuplicateUpload && (
        <DuplicateUploadBadge
          accessibilityLabel={t( "Duplicate-photo-indicator" )}
          className="absolute top-5 left-5 z-10"
          size={24}
          testID="MatchScreen.duplicatePhoto"
        />
      )}

    </Pressable>
  );

  const renderTaxonPhotos = ( ) => (
    <View className={classnames(
      "flex",
      layoutClasses?.taxonPhotosContainerClass,
    )}
    >
      {bestTaxonPhotos.map( photo => (
        <Pressable
          accessibilityRole="button"
          onPress={() => navToTaxonDetails( photo )}
          accessibilityState={{ disabled: false }}
          key={photo.id}
          className={classnames(
            "relative",
            layoutClasses?.taxonPhotoClass,
          )}
        >
          <Image
            testID={`TaxonDetails.photo.${photo.id}`}
            className="w-full h-full"
            source={{
              uri: Photo.displayMediumPhoto( photo.url ),
            }}
            accessibilityIgnoresInvertColors
          />
        </Pressable>
      ) )}
    </View>
  );

  if ( observationPhotos.length === 0 ) {
    return (
      <View className="h-[390px]">
        <IconicTaxonIcon
          iconicTaxonName={taxon?.iconic_taxon_name}
          imageClassName={[
            "grow",
            "aspect-square",
            "bg-darkGray",
            "border-0",
          ]}
          white
          isBackground
          size={120}
        />
      </View>
    );
  }

  if ( displayPortraitLayout === null ) {
    return (
      <View className="h-[390px]" />
    );
  }

  return (
    <View className={classnames( "h-[390px] overflow-hidden", layoutClasses.containerClass )}>
      {renderObservationPhoto( )}
      {!hideTaxonPhotos && bestTaxonPhotos.length > 0 && renderTaxonPhotos( )}
      <MediaViewerModal
        showModal={mediaViewerVisible}
        onClose={( ) => setMediaViewerVisible( false )}
        uri={observationPhoto}
        photos={observationPhotos}
      />
    </View>
  );
};

export default PhotosSection;
