import { Pressable } from "react-native";

// Once wrapped Pressable to log every tap to the remote logger. That logging
// was removed, leaving nothing to add on top of Pressable — kept as an alias
// so the many existing call sites don't all have to change.
export default Pressable;
