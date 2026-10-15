import { Realm } from "@realm/react";
import * as uuid from "uuid";

class LocationHistoryPoint extends Realm.Object {
  uuid!: string;

  latitude!: number;

  longitude!: number;

  accuracy?: number;

  recordedAt!: Date;

  static mapPositionToRealm( position: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    recordedAt: Date;
  } ) {
    return {
      uuid: uuid.v4(),
      latitude: position.latitude,
      longitude: position.longitude,
      accuracy: position.accuracy ?? null,
      recordedAt: position.recordedAt,
    };
  }

  static schema = {
    name: "LocationHistoryPoint",
    primaryKey: "uuid",
    properties: {
      uuid: "string",
      latitude: "double",
      longitude: "double",
      accuracy: "double?",
      recordedAt: "date",
    },
  };
}

export default LocationHistoryPoint;
