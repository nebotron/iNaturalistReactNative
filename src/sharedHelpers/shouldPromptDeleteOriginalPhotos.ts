import useStore from "stores/useStore";

const shouldPromptDeleteOriginalPhotos = ( ): boolean => (
  useStore.getState( ).removedOriginalDevicePhotoUris.length > 0
);

export default shouldPromptDeleteOriginalPhotos;
