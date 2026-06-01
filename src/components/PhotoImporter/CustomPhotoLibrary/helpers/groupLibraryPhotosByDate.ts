import { format, startOfDay } from "date-fns";
import type { i18n as I18n } from "i18next";

import type { LibraryPhoto } from "../types";

export interface DateGroupedLibraryPhotos {
  dateKey: string;
  photos: LibraryPhoto[];
  timestampMs: number;
}

const dateKeyFromTimestamp = ( timestampMs: number ): string => (
  format( startOfDay( new Date( timestampMs ) ), "yyyy-MM-dd" )
);

export const formatPhotoLibraryDateHeader = (
  timestampMs: number,
  i18n: I18n,
): string => format( new Date( timestampMs ), i18n.t( "date-format-long" ) );

export const groupLibraryPhotosByDate = (
  photos: LibraryPhoto[],
): DateGroupedLibraryPhotos[] => {
  const groups = new Map<string, DateGroupedLibraryPhotos>( );

  photos.forEach( photo => {
    const dateKey = dateKeyFromTimestamp( photo.timestampMs );
    const existingGroup = groups.get( dateKey );

    if ( existingGroup ) {
      existingGroup.photos.push( photo );
      return;
    }

    groups.set( dateKey, {
      dateKey,
      photos: [photo],
      timestampMs: startOfDay( new Date( photo.timestampMs ) ).getTime( ),
    } );
  } );

  return [...groups.values( )].sort( ( a, b ) => b.timestampMs - a.timestampMs );
};
