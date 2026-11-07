import { createNativeStackNavigator } from "@react-navigation/native-stack";
import OnboardingCarousel from "components/Onboarding/OnboardingCarousel";
import { preventSwipeToGoBack } from "navigation/navigationOptions";
import type { OnboardingStackParamList } from "navigation/types";
import React from "react";

const Stack = createNativeStackNavigator<OnboardingStackParamList>( );

const OnboardingStackNavigator = ( ) => (
  <Stack.Navigator screenOptions={preventSwipeToGoBack}>
    <Stack.Screen
      name="Onboarding"
      component={OnboardingCarousel}
      options={{
        headerShown: false,
      }}
    />
  </Stack.Navigator>
);

export default OnboardingStackNavigator;
