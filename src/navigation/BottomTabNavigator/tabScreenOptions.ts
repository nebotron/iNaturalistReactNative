import type { BottomTabNavigationOptions } from "@react-navigation/bottom-tabs";

// Note: this file exists so we can mock the screenOptions and disable animations while under test.
// If you update this file, be sure to update the mock in tests/jest.setup.js as well.
const tabScreenOptions: BottomTabNavigationOptions = {
  lazy: true,
  // Disabled: react-native-screens' freezeOnBlur has multiple open upstream
  // bugs where a background tab can come back permanently unresponsive to
  // touch (e.g. software-mansion/react-native-screens#2384, #2971;
  // react-navigation/react-navigation#11555, #12621).
  freezeOnBlur: false,
  headerShown: false,
  animation: "fade",
};

export default tabScreenOptions;
