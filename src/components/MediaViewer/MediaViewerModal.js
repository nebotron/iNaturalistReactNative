// @flow

import MediaViewer from "components/MediaViewer/MediaViewer";
import Modal from "components/SharedComponents/Modal";
import type { Node } from "react";
import React from "react";

type Props = {
  autoPlaySound?: boolean, // automatically start playing a sound when it is visible
  editable?: boolean,
  deleting?: boolean,
  // Optional component to use as the header
  header?: Function,
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
  uri?: string | null
}

const MediaViewerModal = ( {
  autoPlaySound,
  editable,
  deleting,
  header,
  onClose = ( ) => undefined,
  onCropPhoto,
  onDeletePhoto,
  onDeleteSound,
  onReorderPhotos,
  photos = [],
  showModal,
  sounds,
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
        editable={editable}
        deleting={deleting}
        header={header}
        onClose={onClose}
        onCropPhoto={onCropPhoto}
        onDeletePhoto={onDeletePhoto}
        onDeleteSound={onDeleteSound}
        onReorderPhotos={onReorderPhotos}
        photos={photos}
        sounds={sounds}
        uri={uri}
      />
    )}
  />
);

export default MediaViewerModal;
