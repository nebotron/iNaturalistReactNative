import MediaViewer from "components/MediaViewer/MediaViewer";
import Modal from "components/SharedComponents/Modal";
import React from "react";

interface PhotoItem {
  id?: number;
  attribution?: string;
  licenseCode?: string;
  localFilePath?: string;
  url?: string;
}

interface SoundItem {
  file_url: string;
  hidden?: boolean;
}

interface Props {
  autoPlaySound?: boolean; // automatically start playing a sound when it is visible
  autoDetectSubject?: boolean;
  editable?: boolean;
  deleting?: boolean;
  // Optional component to use as the header
  header?: (
    { onClose, photoCount }: { onClose: ( ) => void; photoCount: number}
  ) => React.JSX.Element;
  initialIndex?: number;
  latitude?: number;
  longitude?: number;
  onClose?: ( ) => void;
  onCropPhoto?: ( uri: string ) => void;
  onDeletePhoto?: ( uri: string ) => void;
  onDeleteSound?: ( uri: string ) => void;
  onReorderPhotos?: ( photos: PhotoItem[] ) => void;
  photos?: PhotoItem[];
  sounds?: SoundItem[];
  showModal: boolean;
  timeObservedAt?: string;
  uri?: string | null;
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
}: Props ) => (
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
