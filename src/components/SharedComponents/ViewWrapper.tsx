import classnames from "classnames";
import { View } from "components/styledComponents";
import type { PropsWithChildren } from "react";
import * as React from "react";
import { StatusBar } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface Props extends PropsWithChildren {
  testID?: string;
  // If someone can explain to me why className doesn't work here, I'm all
  // ears ~~~kueda 20230815
  wrapperClassName?: string;
  useTopInset?: boolean;
}

const ViewWrapper = ( {
  children,
  wrapperClassName,
  testID,
  useTopInset = true,
}: Props ) => {
  const insets = useSafeAreaInsets();
  const viewStyle = {
    paddingTop: useTopInset
      ? insets.top
      : 0,
  };
  return (
    <View
      className={classnames(
        "flex-1",
        "bg-white",
        wrapperClassName,
      )}
      style={viewStyle}
      testID={testID}
    >
      <StatusBar barStyle="dark-content" />
      {children}
    </View>
  );
};

export default ViewWrapper;
