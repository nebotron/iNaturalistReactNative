// The location the Photos app itself shows for an asset, read from
// PHAsset.location rather than from the photo file's EXIF.
//
// These are not the same thing. A camera without GPS (a Canon R7, say) writes
// no GPS tags at all, and setting the location by hand in Photos ("Adjust
// Location") records it against the asset in the Photos database — it does not
// rewrite the original file. Importing copies the original file bytes verbatim
// to preserve EXIF, so a location added in Photos was nowhere in the file we
// read and the observation was imported with no location.
//
// PHAsset.location is also the authoritative value when a file does carry GPS:
// Photos seeds it from the file's EXIF and replaces it when the user adjusts
// it. So it takes priority over the file's tags wherever we have it.

export interface DevicePhotoLocation {
  latitude: number;
  longitude: number;
}

interface DevicePhotoLocationLike {
  latitude?: number | null;
  longitude?: number | null;
}

// CameraRoll returns location only when "location" is in getPhotos' include
// list, and reports a locationless asset as null.
export const toDevicePhotoLocation = (
  location?: DevicePhotoLocationLike | null,
): DevicePhotoLocation | null => {
  const { latitude, longitude } = location || {};
  if ( typeof latitude !== "number" || typeof longitude !== "number" ) {
    return null;
  }
  // Photos stores "no location" as a null asset location, but a zero
  // coordinate pair reaching us means something upstream lost it rather than a
  // photo genuinely taken at Null Island.
  if ( latitude === 0 && longitude === 0 ) {
    return null;
  }
  return { latitude, longitude };
};

// The first location any photo in the group carries, matching how EXIF is
// unified across a group's photos (see parseExif).
export const firstDevicePhotoLocation = (
  photos: { image?: { deviceLocation?: DevicePhotoLocationLike | null } }[],
): DevicePhotoLocation | null => {
  for ( const photo of photos || [] ) {
    const location = toDevicePhotoLocation( photo?.image?.deviceLocation );
    if ( location ) return location;
  }
  return null;
};
