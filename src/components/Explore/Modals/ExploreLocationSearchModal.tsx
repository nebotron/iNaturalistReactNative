import type { ApiPlace } from "api/types";
import type { NearbyRadiusConfig } from "components/Explore/NearbyRadiusInput";
import ExploreLocationSearch from "components/Explore/SearchScreens/ExploreLocationSearch";
import Modal from "components/SharedComponents/Modal";
import React from "react";
import type { LocationPermissionCallbacks } from "sharedHooks/useLocationPermission";

interface Props {
  closeModal: () => void;
  hasPermissions?: boolean;
  nearbyRadius?: NearbyRadiusConfig;
  onSelectNearby: ( ) => Promise<void> | void;
  renderPermissionsGate?: ( options: LocationPermissionCallbacks ) => React.FC;
  requestPermissions?: ( ) => void;
  showModal: boolean;
  updateLocation: ( location: "worldwide" | "nearby" | ApiPlace ) => void | Promise<void>;
}

const ExploreLocationSearchModal = ( {
  closeModal,
  hasPermissions,
  nearbyRadius,
  onSelectNearby,
  renderPermissionsGate,
  requestPermissions,
  showModal,
  updateLocation,
}: Props ) => (
  <Modal
    showModal={showModal}
    fullScreen
    closeModal={closeModal}
    disableSwipeDirection
    modal={(
      <ExploreLocationSearch
        closeModal={closeModal}
        hasPermissions={hasPermissions}
        nearbyRadius={nearbyRadius}
        onSelectNearby={onSelectNearby}
        renderPermissionsGate={renderPermissionsGate}
        requestPermissions={requestPermissions}
        updateLocation={updateLocation}
      />
    )}
  />
);

export default ExploreLocationSearchModal;
