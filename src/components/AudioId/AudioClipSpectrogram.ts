import type { ViewProps } from "react-native";
import { requireNativeComponent } from "react-native";

// Registered once here: requireNativeComponent throws when a name is
// registered twice, which at bundle load leaves the app on a black screen.
const AudioClipSpectrogram = requireNativeComponent<ViewProps & { path: string }>(
  "AudioClipSpectrogram",
);

export default AudioClipSpectrogram;
