import { useEffect } from "react";

// System share sheet / iOS Share extension were removed so the app stays a single native target
// (simpler EAS credentials). Opening shared photos from other apps is no longer supported here.
const useShare = ( _onShare: ( item?: unknown ) => void ): void => {
  useEffect( () => {}, [] );
};

export default useShare;
