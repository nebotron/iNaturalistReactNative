import type { i18n as I18n } from "i18next";

import type {
  LibraryPhoto,
  PhotoLibraryListItem,
} from "../types";
import { formatPhotoLibraryDateHeader, groupLibraryPhotosByDate } from "./groupLibraryPhotosByDate";

const PHOTOS_PER_ROW = 3;

const buildPhotoLibraryListItems = (
  photos: LibraryPhoto[],
  i18n: I18n,
): PhotoLibraryListItem[] => {
  const groupedPhotos = groupLibraryPhotosByDate( photos );
  const listItems: PhotoLibraryListItem[] = [];

  groupedPhotos.forEach( group => {
    listItems.push( {
      type: "header",
      dateKey: group.dateKey,
      title: formatPhotoLibraryDateHeader( group.timestampMs, i18n ),
    } );

    for ( let index = 0; index < group.photos.length; index += PHOTOS_PER_ROW ) {
      listItems.push( {
        type: "row",
        photos: group.photos.slice( index, index + PHOTOS_PER_ROW ),
      } );
    }
  } );

  return listItems;
};

export default buildPhotoLibraryListItems;
