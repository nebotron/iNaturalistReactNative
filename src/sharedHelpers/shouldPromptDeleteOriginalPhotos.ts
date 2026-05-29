import useStore from "stores/useStore";

const shouldPromptDeleteOriginalPhotos = ( ): boolean => (
  useStore.getState( ).originalDevicePhotoUris.length > 0
);

export default shouldPromptDeleteOriginalPhotos;
