import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";

export type GearKind = "camera" | "lens";

// User-chosen names for cameras and lenses, keyed by the name read from EXIF
export type GearNicknames = Record<GearKind, Record<string, string>>;

// The nickname for a camera or lens, else its EXIF name
export const gearName = (
  nicknames: GearNicknames | undefined,
  kind: GearKind,
  name?: string,
): string | undefined => ( name
  ? nicknames?.[kind]?.[name] || name
  : name );

// Camera info with nicknames in place of EXIF camera and lens names, for display
export const withGearNicknames = <T extends PhotoCameraInfo | null | undefined>(
  info: T,
  nicknames: GearNicknames | undefined,
): T => ( info
    ? {
      ...info,
      camera: gearName( nicknames, "camera", info.camera ),
      lens: gearName( nicknames, "lens", info.lens ),
    }
    : info );
