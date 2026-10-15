import { Realm } from "@realm/react";

class InputImageRecord extends Realm.Object {
  uuid!: string;

  originalUri!: string;

  fileName!: string;

  source!: string;

  loadedAt!: Date;

  wasDeleted!: boolean;

  deletedAt?: Date;

  wasCropped!: boolean;

  // Normalized crop values (0–1), matching NormalizedCrop: x, y, w, h
  cropX?: number;

  cropY?: number;

  cropW?: number;

  cropH?: number;

  static schema = {
    name: "InputImageRecord",
    primaryKey: "uuid",
    properties: {
      uuid: "string",
      originalUri: "string",
      fileName: "string",
      // "camera" | "photoLibrary"
      source: "string",
      loadedAt: "date",
      wasDeleted: { type: "bool", default: false },
      deletedAt: "date?",
      wasCropped: { type: "bool", default: false },
      cropX: "float?",
      cropY: "float?",
      cropW: "float?",
      cropH: "float?",
    },
  };
}

export default InputImageRecord;
