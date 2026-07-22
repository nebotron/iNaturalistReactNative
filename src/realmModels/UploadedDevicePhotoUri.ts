import { Realm } from "@realm/react";

class UploadedDevicePhotoUri extends Realm.Object {
  static schema = {
    name: "UploadedDevicePhotoUri",
    primaryKey: "uri",
    properties: {
      uri: "string",
      uploadedAt: "date",
    },
  };
}

export default UploadedDevicePhotoUri;
