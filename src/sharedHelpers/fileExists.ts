import { exists } from "@dr.pogodin/react-native-fs";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";

// Whether a file:// URI or path is on disk; false rather than throwing
const fileExists = async ( uri: string | null | undefined ): Promise<boolean> => (
  !!uri && exists( stripFilePrefix( uri ) ).catch( ( ) => false )
);

export default fileExists;
