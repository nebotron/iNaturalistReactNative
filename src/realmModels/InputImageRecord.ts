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

  cropX?: number;

  cropY?: number;

  cropWidth?: number;

  cropHeight?: number;

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
      cropWidth: "float?",
      cropHeight: "float?",
    },
  };
}

export default InputImageRecord;
