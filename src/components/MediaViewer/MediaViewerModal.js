// @flow

import MediaViewer from "components/MediaViewer/MediaViewer";
import Modal from "components/SharedComponents/Modal";
import type { Node } from "react";
import React from "react";

type Props = {
  autoPlaySound?: boolean, // automatically start playing a sound when it is visible
  autoDetectSubject?: boolean,
  editable?: boolean,
  deleting?: boolean,
  // Optional component to use as the header
  header?: Function,
  initialIndex?: number,
  latitude?: number,
  longitude?: number,
  onClose?: Function,
  onCropPhoto?: Function,
  onDeletePhoto?: Function,
  onDeleteSound?: Function,
  onReorderPhotos?: Function,
  photos?: {
    id?: number,
    url: string,
    localFilePath?: string,
    attribution?: string,
    licenseCode?: string
  }[],
  sounds?: {
    file_url: string
  }[],
  showModal: boolean,
  timeObservedAt?: string,
  uri?: string | null
}

const MediaViewerModal = ( {
  autoPlaySound,
  autoDetectSubject,
  editable,
  deleting,
  header,
  initialIndex,
  latitude,
  longitude,
  onClose = ( ) => undefined,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onReorderPhotos,
  photos = [],
  showModal,
  sounds,
  timeObservedAt,
  uri,
}: Props ): Node => (
  <Modal
    showModal={showModal}
    fullScreen
    closeModal={onClose}
    disableSwipeDirection
    modal={(
      <MediaViewer
        autoPlaySound={autoPlaySound}
        autoDetectSubject={autoDetectSubject}
        editable={editable}
        deleting={deleting}
        header={header}
        initialIndex={initialIndex}
        latitude={latitude}
        longitude={longitude}
        onClose={onClose}
        onCropPhoto={onCropPhoto}
        onDeletePhoto={onDeletePhoto}
        onDeleteSound={onDeleteSound}
        onReorderPhotos={onReorderPhotos}
        photos={photos}
        sounds={sounds}
        timeObservedAt={timeObservedAt}
        uri={uri}
      />
    )}
  />
);

export default MediaViewerModal;
