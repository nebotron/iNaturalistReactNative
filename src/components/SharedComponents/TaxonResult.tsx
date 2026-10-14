import { useNavigation } from "@react-navigation/native";
import type { ApiTaxon } from "api/types";
import classnames from "classnames";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import {
  Body3,
  DisplayTaxonName,
  INatIconButton,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import type {
  NoBottomTabStackScreenProps,
  SharedStackParamList,
  TabStackScreenProps,
} from "navigation/types";
import type { PropsWithChildren } from "react";
import React from "react";
import type { RealmTaxon, RealmTaxonPhoto } from "realmModels/types";
import { accessibleTaxonName } from "sharedHelpers/taxon";
import { useCurrentUser, useTaxon, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import ConfidenceInterval from "./ConfidenceInterval";

interface TaxonResultBaseProps {
  accessibilityHint?: string;
  activeColor?: string;
  asListItem?: boolean;
  clearBackground?: boolean;
  confidence?: number;
  confidencePosition?: string;
  confidencePercentage?: number | null;
  fetchRemote?: boolean;
  first?: boolean;
  fromLocal?: boolean;
  handleRemovePress?: () => void;
  hideInfoButton?: boolean;
  hideNavButtons?: boolean;
  lastScreen?: "Suggestions";
  onPressInfo?: ( taxon: RealmTaxon | ApiTaxon ) => void;
  onSelectGenus?: () => void;
  retryQuery?: boolean;
  showCheckmark?: boolean;
  showEditButton?: boolean;
  showRemoveButton?: boolean;
  taxon: RealmTaxon | ApiTaxon;
  testID: string;
  vision?: boolean;
  white?: boolean;
}

type TaxonResultProps = TaxonResultBaseProps &
  (
    | {
        unpressable: true; // Overrides other props controlling interactive elements
        handleTaxonOrEditPress?: never;
      }
    | {
        unpressable?: false;
        handleTaxonOrEditPress: ( taxon?: RealmTaxon | ApiTaxon ) => void;
      }
  );

interface TaxonResultMainProps extends PropsWithChildren {
  accessibilityHint?: string;
  accessibilityLabel: string;
  className?: string;
  onPress?: ( ) => void;
  testID: string;
  unpressable: boolean;
}

// Defined outside TaxonResult so it keeps one component identity: a component
// recreated on every render remounts its subtree, which drops a press that is
// in progress whenever the parent list re-renders.
const TaxonResultMain = ( {
  accessibilityHint,
  accessibilityLabel,
  children,
  className,
  onPress,
  testID,
  unpressable,
}: TaxonResultMainProps ) => (
  unpressable
    ? <View className={className} testID={testID}>{ children }</View>
    : (
      <Pressable
        className={className}
        testID={testID}
        onPress={onPress}
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
      >
        { children }
      </Pressable>
    )
);

// What a row represented when a button press on it began
interface PressTarget {
  onSelectGenus?: ( ) => void;
  taxon: RealmTaxon | ApiTaxon;
}

const TaxonResult = ( {
  accessibilityHint,
  activeColor,
  asListItem = true,
  clearBackground,
  confidence,
  confidencePercentage,
  confidencePosition = "photo",
  fetchRemote = true,
  first = false,
  fromLocal = true,
  handleRemovePress,
  handleTaxonOrEditPress,
  hideInfoButton = false,
  hideNavButtons = false,
  lastScreen,
  onPressInfo,
  onSelectGenus,
  retryQuery = true,
  showCheckmark = false,
  showEditButton = false,
  showRemoveButton = false,
  taxon: taxonProp,
  testID,
  unpressable = false,
  vision = false,
  white = false,
}: TaxonResultProps ) => {
  const { t } = useTranslation( );
  // TaxonResult is imported in
  // AICamera
  // ExploreTaxonSearch
  // MatchTaxonSearch
  // IdentificationSection
  // Suggestion
  // SuggestionsTaxonSearch
  // However, navigation is only used if
  // unpressable is false and hideInfoButton is false and onPressInfo is not provided
  // or
  // unpressable is false and handleTaxonOrEditPress is not provided
  const navigation = useNavigation<
    TabStackScreenProps<
      "MatchTaxonSearchScreen" | "Suggestions" | "SuggestionsTaxonSearch"
    >["navigation"] &
    NoBottomTabStackScreenProps<
      "MatchTaxonSearchScreen" | "Suggestions" | "SuggestionsTaxonSearch"
    >["navigation"]
  >( );

  // With the current implementation and usage throughout the app of this component,
  // we either want it to be not pressable or we want it pressable and we provide a
  // onPress callback. Since I removed the default onPress function for none being propped in,
  // I added this error to assert correct prop usage.
  if ( !unpressable && handleTaxonOrEditPress === undefined ) {
    throw new Error( "You have to provide a primary onPress action!" );
  }

  const currentUser = useCurrentUser( );

  // thinking about future performance, it might make more sense to batch
  // network requests for useTaxon instead of making individual API calls.
  // right now, this fetches a single taxon at a time on AI camera &
  // a short list of taxa from offline Suggestions
  const { taxon: localTaxon } = useTaxon(
    taxonProp,
    fetchRemote,
    retryQuery,
  ) as { taxon: RealmTaxon };
  const usableTaxon = fromLocal
    ? localTaxon
    : taxonProp;
  const accessibleName = accessibleTaxonName( usableTaxon, currentUser, t );
  // A representative photo is dependant on the actual image that was scored by computer vision
  // and is currently not added to the taxon realm. So, if it is available directly from the
  // suggestion, i.e. taxonProp, use it. Otherwise, use the default photo from the taxon.
  const representativePhoto = ( taxonProp as ApiTaxon )?.representative_photo;
  // I have seen the RealmTaxon that is accessed here get invalidated and deleted
  // while this screen is still in stack and therefore the app erroring out.
  // Have not had time to investigate further, but this is a workaround for now.
  const taxonImagePointer = representativePhoto
      || ( usableTaxon as ApiTaxon )?.default_photo
      || ( usableTaxon as RealmTaxon )?.defaultPhoto;
  const taxonImage = React.useMemo( () => ( { ...taxonImagePointer } ), [taxonImagePointer] );

  const taxonImageSource = { uri: taxonImage?.url };

  const isRepresentativeButOtherTaxon = representativePhoto
    && !localTaxon?.taxonPhotos?.some(
      ( tp: RealmTaxonPhoto ) => tp.photo.id === representativePhoto.id,
    );

  // Remember what this row represented when the finger went down. Lists like
  // Suggestions can reflow mid-tap (e.g. online results replacing offline
  // ones), and without this a press would act on whatever taxon happens to
  // occupy the row by the time it's released. Freezing the target for the
  // duration of the touch means such a press is safe to honor rather than
  // having to be discarded, which is what made buttons feel unresponsive.
  const pressTargetRef = React.useRef<PressTarget | null>( null );
  const capturePressTarget = React.useCallback( ( ) => {
    pressTargetRef.current = { onSelectGenus, taxon: usableTaxon };
  }, [onSelectGenus, usableTaxon] );
  // onPressOut runs synchronously before onPress, so clear the capture after
  // the current tick instead: by then the press has resolved or been
  // cancelled, and nothing stale is left for the next one, including an
  // accessibility activation, which fires onPress with no onPressIn
  const releasePressTarget = React.useCallback( ( ) => {
    setTimeout( ( ) => { pressTargetRef.current = null; }, 0 );
  }, [] );

  const navToTaxonDetails = React.useCallback( ( ) => {
    const params: SharedStackParamList["TaxonDetails"] = {
      id: usableTaxon?.id,
      hideNavButtons,
      lastScreen,
      vision,
    };
    if ( !isRepresentativeButOtherTaxon ) {
      params.firstPhotoID = taxonImage?.id;
    } else {
      params.representativePhoto = taxonImage;
    }
    navigation.push( "TaxonDetails", params );
  }, [
    hideNavButtons,
    lastScreen,
    navigation,
    usableTaxon?.id,
    vision,
    taxonImage,
    isRepresentativeButOtherTaxon,
  ] );

  // useTaxon could return null, and it's at least remotely possible taxonProp is null
  if ( !usableTaxon ) return null;

  return (
    <View
      className={
        classnames(
          "flex-row items-center justify-between",
          {
            "px-4": asListItem,
            "border-b-[1px] border-lightGray": asListItem,
            "border-t-[1px]": first,
          },
        )
      }
    >
      <TaxonResultMain
        accessibilityHint={accessibilityHint}
        accessibilityLabel={accessibleName}
        onPress={( ) => handleTaxonOrEditPress?.( usableTaxon )}
        testID={testID}
        unpressable={unpressable}
        className={
          classnames( "flex-row items-center shrink", {
            "py-3": asListItem,
          } )
        }
      >
        <View className="w-[62px] h-[62px] justify-center relative">
          <ObsImagePreview
            // TODO fix when ObsImagePreview typed
            source={taxonImageSource}
            testID={`${testID}.photo`}
            iconicTaxonName={usableTaxon?.iconic_taxon_name}
            className="rounded-xl"
            isSmall
            white={white}
            isBackground={false}
          />
          {!!( confidence && confidencePosition === "photo" ) && (
            <View className="absolute -bottom-4 w-full items-center">
              <ConfidenceInterval
                confidence={confidence}
                activeColor={activeColor}
              />
            </View>
          )}
        </View>
        <View className="shrink ml-3 flex-1">
          <DisplayTaxonName
            taxon={usableTaxon}
            color={String(
              clearBackground
                ? "text-white"
                : "text-darkGray",
            )}
            scientificNameFirst={currentUser?.prefers_scientific_name_first}
            prefersCommonNames={currentUser?.prefers_common_names}
          />
          {!!( ( confidence || confidencePercentage ) && confidencePosition === "text" ) && (
            <View className="mt-1 w-[62px]">
              {confidencePercentage
                ? (
                  <Body3 className="color-inatGreen">
                    {t( "X-percent", { count: confidencePercentage } )}
                  </Body3>
                )
                : (
                  <ConfidenceInterval
                    confidence={confidence}
                    activeColor={activeColor}
                  />
                )}
            </View>
          )}
        </View>
      </TaxonResultMain>
      { !unpressable && (
        <View className="flex-row items-center">
          { onSelectGenus && (
            <INatIconButton
              icon="arrow-up-bold-circle-outline"
              size={22}
              onPressIn={capturePressTarget}
              onPressOut={releasePressTarget}
              onPress={( ) => (
                pressTargetRef.current?.onSelectGenus || onSelectGenus
              )?.( )}
              color={String(
                clearBackground
                  ? colors?.white
                  : colors?.darkGray,
              )}
              accessibilityLabel={t( "SUGGEST-GENUS" )}
            />
          )}
          { !hideInfoButton && (
            <INatIconButton
              icon="info-circle-outline"
              size={22}
              onPress={( ) => {
                if ( typeof ( onPressInfo ) === "function" ) {
                  onPressInfo( usableTaxon );
                  return;
                }
                navToTaxonDetails( );
              }}
              color={String(
                clearBackground
                  ? colors?.white
                  : colors?.darkGray,
              )}
              accessibilityLabel={t( "More-info" )}
              accessibilityHint={t( "Navigates-to-taxon-details" )}
            />
          )}
          { showCheckmark && (
            <INatIconButton
              className="ml-2"
              icon="checkmark-circle-outline"
              size={40}
              color={String(
                clearBackground
                  ? colors?.white
                  : colors?.darkGray,
              )}
              onPressIn={capturePressTarget}
              onPressOut={releasePressTarget}
              onPress={() => handleTaxonOrEditPress?.(
                pressTargetRef.current?.taxon || usableTaxon,
              )}
              accessibilityLabel={accessibleName}
              accessibilityHint={accessibilityHint}
              testID={`${testID}.checkmark`}
            />
          )}
          { showEditButton && handleTaxonOrEditPress
              && (
                <INatIconButton
                  icon="edit"
                  size={20}
                  onPress={( ) => handleTaxonOrEditPress( )}
                  accessibilityLabel={t( "Edit-identification" )}
                  accessibilityHint={t( "Edits-this-observations-taxon" )}
                />
              )}
          { showRemoveButton && handleRemovePress
            && (
              <INatIconButton
                icon="close"
                size={20}
                onPress={handleRemovePress}
                accessibilityLabel={t( "Remove-identification" )}
                accessibilityHint={t( "Removes-this-observations-taxon" )}
              />
            )}
        </View>
      ) }
    </View>
  );
};

export default TaxonResult;
