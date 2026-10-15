import type { SharedValue } from "react-native-reanimated";

export const sum = ( ...animatedValues: SharedValue<number>[] ) => {
  "worklet";

  return animatedValues.reduce(
    ( result, animatedValue ) => result + animatedValue.value,
    0,
  );
};
