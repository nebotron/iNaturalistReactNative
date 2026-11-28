import { useNavigation } from "@react-navigation/native";
import type { ApiPlace, ApiProjectSummary } from "api/types";
import { OBSERVATIONS_TAB } from "appConstants/tabs";
import DateFilterSection
  from "components/Explore/components/DateFilterSection";
import RadioGroupSection
  from "components/Explore/components/RadioGroupSection";
import SavedSearches, { SavedSearchSheets }
  from "components/Explore/components/SavedSearches";
import SelectedFilterRow
  from "components/Explore/components/SelectedFilterRow";
import ExploreTaxonFiltersSection from "components/Explore/ExploreTaxonFiltersSection";
import {
  getDateObservedValues,
  getDateUploadedValues,
  getEstablishmentValues,
  getEvidenceTypeValues,
  getMediaValues,
  getMonthValues,
  getPhotoLicenseValues,
  getReviewedValues,
  getTaxonomicRankValues,
  getWildValues,
} from "components/Explore/helpers/advancedSearchOptions";
import {
  advancedSearchReducer,
  defaultAdvancedSearchDraft,
  draftFromV2State,
  searchTaxonFilters,
} from "components/Explore/helpers/advancedSearchReducer";
import locationLabel from "components/Explore/helpers/locationLabel";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import { toggleTaxonFilter } from "components/Explore/helpers/taxonFilters";
import useApplySavedSearch, {
  useReplaceHotspotExplore,
} from "components/Explore/hooks/useApplySavedSearch";
import {
  useExploreGridOverlays, useExploreLayoutKey,
} from "components/Explore/hooks/useExploreDisplaySettings";
import ExploreLocationSearchModal from "components/Explore/Modals/ExploreLocationSearchModal";
import ExploreProjectSearchModal from "components/Explore/Modals/ExploreProjectSearchModal";
import ExploreTaxonSearchModal from "components/Explore/Modals/ExploreTaxonSearchModal";
import ExploreUserSearchModal from "components/Explore/Modals/ExploreUserSearchModal";
import type { ExploreSearchUser }
  from "components/Explore/SearchScreens/ExploreUserSearch";
import ProjectListItem from "components/ProjectList/ProjectListItem";
import {
  Body2,
  Body3,
  Button,
  ButtonBar,
  Checkbox,
  Heading4,
  IconicTaxonChooser,
  INatIcon,
  PickerSheet,
  RadioButtonSheet,
} from "components/SharedComponents";
import SearchHeader from "components/SharedComponents/SearchHeader";
import WarningSheet from "components/SharedComponents/Sheets/WarningSheet";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { NestableScrollContainer, View } from "components/styledComponents";
import UserListItem from "components/UserList/UserListItem";
import isEqual from "lodash/isEqual";
import type { ExploreStackScreenProps } from "navigation/types";
import {
  DATE_OBSERVED,
  DATE_UPLOADED,
  EXPLORE_ACTION,
  EXPLORE_PLACE_MODE,
  useExplore,
} from "providers/ExploreContext";
import React, { useMemo, useReducer, useState } from "react";
import { formatObsFieldDate, getMonthsAroundDate } from "sharedHelpers/dateAndTime";
import { DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM } from "sharedHelpers/nearbyRadius";
import { useCurrentUser, useTranslation } from "sharedHooks";
import useIconicTaxa from "sharedHooks/useIconicTaxa";
import useStoredLayout from "sharedHooks/useStoredLayout";
import type { SavedSearch } from "stores/createExploreSearchesSlice";
import { findSavedSearchByName } from "stores/createExploreSearchesSlice";
import useStore from "stores/useStore";

type SheetName = "hrank" | "lrank" | "photoLicense" | "excludeSavedSearch";

type PickerKind = "taxon" | "user" | "project" | "location";

const isoToday = ( ) => formatObsFieldDate( new Date( ) );

const AdvancedSearch = ( ) => {
  const navigation
    = useNavigation<ExploreStackScreenProps<"AdvancedSearch">["navigation"]>();
  const { t } = useTranslation();
  const iconicTaxa = useIconicTaxa();
  const currentUser = useCurrentUser();

  const { state: v2State, dispatch: dispatchV2 } = useExplore();
  const applySavedSearch = useApplySavedSearch( );
  const replaceHotspotExplore = useReplaceHotspotExplore( );
  const [initialDraft] = useState( ( ) => draftFromV2State( v2State ) );
  const [draft, dispatch] = useReducer( advancedSearchReducer, initialDraft );
  const {
    subject, location, sortBy, filters,
  } = draft;

  const {
    layout: observationsLayout,
    writeLayoutToStorage: writeObservationsLayout,
  } = useStoredLayout( useExploreLayoutKey( ) );
  const showingObservationsMap = v2State.activeTab === OBSERVATIONS_TAB
    && observationsLayout === "map";
  // Reset also returns Explore to the observations map, once the search is run
  const [viewReset, setViewReset] = useState( false );
  const pendingViewChange = viewReset && !showingObservationsMap;

  const differsFromInitial = useMemo(
    ( ) => pendingViewChange || !isEqual( draft, initialDraft ),
    [pendingViewChange, draft, initialDraft],
  );

  const resetDisabled = useMemo(
    ( ) => isEqual( draft, defaultAdvancedSearchDraft )
      && ( viewReset || showingObservationsMap ),
    [draft, viewReset, showingObservationsMap],
  );

  const reset = ( ) => {
    dispatch( { type: "RESET" } );
    setViewReset( true );
  };
  const { overlays: gridOverlays } = useExploreGridOverlays( );
  const savedSearches = useStore( state => state.exploreSavedSearches.searches );
  const [pendingExit, setPendingExit] = useState( false );
  const [showSaveSheet, setShowSaveSheet] = useState( false );
  const [searchToDelete, setSearchToDelete] = useState<SavedSearch | null>( null );
  const currentSearch = {
    subject, location, sortBy, speciesSortBy: v2State.speciesSortBy, filters,
  };
  // Saved searches also remember the view they were saved from
  const currentSavedSearch = {
    ...currentSearch,
    activeTab: v2State.activeTab,
    observationsLayout: observationsLayout ?? undefined,
    gridOverlays,
  };
  const requestExit = ( ) => {
    if ( differsFromInitial ) {
      setPendingExit( true );
      return;
    }
    navigation.goBack( );
  };

  // Which in-screen search picker (taxon/user/project/location) is open.
  const [openPicker, setOpenPicker] = useState<PickerKind | null>( null );
  const [openSheet, setOpenSheet] = useState<SheetName | null>( null );
  const closeSheet = ( ) => setOpenSheet( null );

  const updateTaxonFilters = ( taxonFilters: ExploreTaxonFilter[] ) => dispatch( {
    type: "SET_TAXON_FILTERS",
    taxonFilters,
  } );

  const filterByIconicTaxonUnknown = () => dispatch( {
    type: "FILTER_BY_ICONIC_UNKNOWN",
  } );

  const updateUser = ( selectedUser: ExploreSearchUser | null ) => dispatch( {
    type: "SET_USER",
    user: selectedUser,
  } );

  const updateExcludeSpeciesInSavedSearch = ( name: string | null ) => dispatch( {
    type: "SET_EXCLUDE_SPECIES_IN_SAVED_SEARCH",
    name,
  } );

  const updateProject = ( selectedProject: ApiProjectSummary | null ) => dispatch( {
    type: "SET_PROJECT",
    project: selectedProject,
  } );

  const updateLocation = ( newLocation: "worldwide" | ApiPlace ) => {
    if ( newLocation === "worldwide" ) {
      dispatch( { type: "SET_LOCATION_WORLDWIDE" } );
      return;
    }
    if ( !newLocation.id ) { return; }
    dispatch( {
      type: "SET_LOCATION_PLACE",
      place: { id: newLocation.id, display_name: newLocation.display_name },
    } );
  };

  const closePicker = ( ) => setOpenPicker( null );

  const isNearby = location.placeMode === EXPLORE_PLACE_MODE.NEARBY;
  const nearbyRadiusKm = ( isNearby && location.radius ) || DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM;
  const setNearby = ( radius = nearbyRadiusKm ) => dispatch( {
    type: "SET_LOCATION_NEARBY",
    radius,
  } );

  const handleSearch = () => {
    // A reset search from a hotspot's Explore replaces the Hotspots view
    // underneath it too, rather than leaving a way back to the hotspot
    if ( viewReset && replaceHotspotExplore( {
      ...currentSearch,
      activeTab: OBSERVATIONS_TAB,
      observationsLayout: "map",
      key: "",
      savedAt: Date.now( ),
    } ) ) {
      return;
    }
    if ( viewReset ) {
      writeObservationsLayout( "map" );
    }
    dispatchV2( {
      type: EXPLORE_ACTION.APPLY_SEARCH,
      search: viewReset
        ? { ...currentSearch, activeTab: OBSERVATIONS_TAB }
        : currentSearch,
    } );
    navigation.popTo( "ExploreResults" );
  };

  const {
    casual,
    created_d1: createdD1,
    created_d2: createdD2,
    created_on: createdOn,
    d1,
    d2,
    dateObserved,
    dateUploaded,
    establishmentMean,
    evidenceTypes,
    hrank,
    lrank,
    media,
    months,
    needsID,
    observed_on: observedOn,
    photoLicense,
    favedByMe,
    project,
    researchGrade,
    reviewedFilter,
    excludeSpeciesInSavedSearch,
    user,
    wildStatus,
  } = filters;

  // Saved searches are referenced by name, so only named ones can be picked
  const namedSavedSearches = savedSearches.filter( saved => !!saved.name?.trim( ) );
  const excludedSavedSearchMissing = !!excludeSpeciesInSavedSearch
    && !findSavedSearchByName( savedSearches, excludeSpeciesInSavedSearch );
  const excludeSavedSearchValues = Object.fromEntries( namedSavedSearches.map( saved => [
    saved.key,
    { label: saved.name as string, value: saved.name as string },
  ] ) );

  const taxonFilters = searchTaxonFilters( subject, filters );
  const taxonUnknown = subject?.type === "unknown";
  const chosenIconicTaxa = taxonUnknown
    ? ["unknown"]
    : taxonFilters
      .filter( filter => !filter.exclude )
      .map( filter => filter.taxon.name?.toLowerCase( ) )
      .filter( ( name ): name is string => !!name );

  const displayProject = project;

  const taxonomicRankValues = getTaxonomicRankValues( t );
  const dateObservedValues = getDateObservedValues( t );
  const dateUploadedValues = getDateUploadedValues( t );
  const monthValues = getMonthValues( t );
  const photoLicenseValues = getPhotoLicenseValues( t );

  const updateDateObserved = ( {
    newDateObserved, newObservedOn, newD1, newD2, newMonths,
  } ) => {
    const today = isoToday( );

    if ( newDateObserved === DATE_OBSERVED.ALL ) {
      dispatch( {
        type: "SET_DATE_OBSERVED_ALL",
      } );
    } else if ( newDateObserved === DATE_OBSERVED.EXACT_DATE ) {
      dispatch( {
        type: "SET_DATE_OBSERVED_EXACT",
        observedOn: newObservedOn || today,
      } );
    } else if ( newDateObserved === DATE_OBSERVED.DATE_RANGE ) {
      dispatch( {
        type: "SET_DATE_OBSERVED_RANGE",
        d1: newD1 || today,
        d2: newD2 || today,
      } );
    } else if ( newDateObserved === DATE_OBSERVED.MONTHS ) {
      dispatch( {
        type: "SET_DATE_OBSERVED_MONTHS",
        months: newMonths || getMonthsAroundDate( ),
      } );
    }
  };

  const updateObservedMonths = monthInteger => {
    const currentMonths = months || [];
    const newMonths = currentMonths.includes( monthInteger )
      ? currentMonths.filter( m => m !== monthInteger )
      : [...currentMonths, monthInteger];
    updateDateObserved( {
      newDateObserved: DATE_OBSERVED.MONTHS,
      newMonths,
    } );
  };

  const updateDateUploaded = ( { newDateUploaded, newD1, newD2 } ) => {
    const today = isoToday( );
    if ( newDateUploaded === DATE_UPLOADED.ALL ) {
      dispatch( {
        type: "SET_DATE_UPLOADED_ALL",
      } );
    } else if ( newDateUploaded === DATE_UPLOADED.EXACT_DATE ) {
      dispatch( {
        type: "SET_DATE_UPLOADED_EXACT",
        createdOn: newD1 || today,
      } );
    } else if ( newDateUploaded === DATE_UPLOADED.DATE_RANGE ) {
      dispatch( {
        type: "SET_DATE_UPLOADED_RANGE",
        createdD1: newD1 || today,
        createdD2: newD2 || today,
      } );
    }
  };

  const observedEndBeforeStart = d1 > d2;
  const uploadedEndBeforeStart = createdD1 > createdD2;
  // MONTHS mode with nothing checked emits no `month` param, which would
  // silently run an unfiltered search; block Search until a month is selected.
  const noMonthsSelected = dateObserved === DATE_OBSERVED.MONTHS
    && ( months || [] ).length === 0;
  const hasError = observedEndBeforeStart || uploadedEndBeforeStart || noMonthsSelected
    || excludedSavedSearchMissing;

  return (
    <SharedStackViewWrapper testID="AdvancedSearch">
      <SearchHeader
        headerText={t( "SEARCH" )}
        onClose={requestExit}
        onReset={reset}
        resetDisabled={resetDisabled}
        testID="AdvancedSearch.back"
      />

      {/* Nestable so the saved searches list can be dragged to reorder inside it */}
      <NestableScrollContainer className="py-4">
        <SavedSearches
          currentSearch={currentSavedSearch}
          onDelete={setSearchToDelete}
          onSave={( ) => setShowSaveSheet( true )}
          onSelect={applySavedSearch}
        />

        {/* Taxon Section */}
        <ExploreTaxonFiltersSection
          iconicTaxonNames={taxonUnknown
            ? ["unknown"]
            : []}
          onOpenTaxonSearch={() => setOpenPicker( "taxon" )}
          taxonFilters={taxonFilters}
          updateTaxonFilters={updateTaxonFilters}
        />
        <View className="mb-7">
          <IconicTaxonChooser
            chosen={chosenIconicTaxa}
            onTaxonChosen={( taxonName: string ) => {
              if ( taxonName === "unknown" ) {
                if ( taxonUnknown ) {
                  updateTaxonFilters( [] );
                } else {
                  filterByIconicTaxonUnknown();
                }
                return;
              }
              const selectedTaxon = iconicTaxa
                ?.filtered( "name ==[c] $0", taxonName );
              if ( selectedTaxon && selectedTaxon.length > 0 ) {
                updateTaxonFilters(
                  toggleTaxonFilter( taxonFilters, selectedTaxon[0], false ),
                );
              }
            }}
          />
          <View className="px-4 mt-5" testID="AdvancedSearch.excludeSavedSearch">
            {excludeSpeciesInSavedSearch
              ? (
                <>
                  <SelectedFilterRow
                    accessibilityLabel={t( "Change-saved-search-to-exclude" )}
                    onEdit={() => setOpenSheet( "excludeSavedSearch" )}
                    onRemove={() => updateExcludeSpeciesInSavedSearch( null )}
                    removeAccessibilityLabel={t( "Stop-excluding-saved-search" )}
                  >
                    <Body3 className="flex-1">
                      {t( "Excluding-species-in-saved-search", {
                        name: excludeSpeciesInSavedSearch,
                      } )}
                    </Body3>
                  </SelectedFilterRow>
                  {excludedSavedSearchMissing && (
                    <Body3
                      className="mt-2 text-warningRed"
                      testID="AdvancedSearch.excludeSavedSearchMissing"
                    >
                      {t( "Excluded-saved-search-not-found", {
                        name: excludeSpeciesInSavedSearch,
                      } )}
                    </Body3>
                  )}
                </>
              )
              : namedSavedSearches.length > 0 && (
                <Button
                  level="neutral"
                  text={t( "EXCLUDE-SPECIES-IN-A-SAVED-SEARCH" )}
                  onPress={() => setOpenSheet( "excludeSavedSearch" )}
                  accessibilityLabel={t( "Exclude-species-in-a-saved-search" )}
                />
              )}
          </View>
        </View>
        <View className="px-4 pb-4">
          {/* Location Section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "LOCATION" )}</Heading4>
            <View className="mb-5">
              <View>
                <View className="flex-row items-center mb-5">
                  <INatIcon name="location" size={15} />
                  <Body3 className="ml-4">{locationLabel( location, t )}</Body3>
                </View>
                <Button
                  text={t( "EDIT-LOCATION" )}
                  onPress={() => {
                    setOpenPicker( "location" );
                  }}
                  accessibilityLabel={t( "Edit" )}
                />
              </View>
            </View>
          </View>

          {/* Quality Grade Section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "QUALITY-GRADE" )}</Heading4>
            <View className="mb-5">
              <Checkbox
                text={t( "Research-Grade--quality-grade" )}
                isChecked={researchGrade}
                onPress={() => dispatch( { type: "TOGGLE_RESEARCH_GRADE" } )}
              />
              <View className="mb-4" />
              <Checkbox
                text={t( "Needs-ID--quality-grade" )}
                isChecked={needsID}
                onPress={() => dispatch( { type: "TOGGLE_NEEDS_ID" } )}
              />
              <View className="mb-4" />
              <Checkbox
                text={t( "Casual--quality-grade" )}
                isChecked={casual}
                onPress={() => dispatch( { type: "TOGGLE_CASUAL" } )}
              />
            </View>
          </View>

          {/* User Section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "USER" )}</Heading4>
            <View className="mb-5">
              {user && (
                <SelectedFilterRow
                  accessibilityLabel={t( "Change-user" )}
                  justify="justify-around"
                  onEdit={() => setOpenPicker( "user" )}
                  onRemove={() => updateUser( null )}
                  removeAccessibilityLabel={t( "Remove-user-filter" )}
                >
                  <UserListItem
                    item={{ user }}
                    countText={t( "X-Observations", { count: user.observations_count } )}
                    pressable={false}
                  />
                </SelectedFilterRow>
              )}
              {!user && (
                <Button
                  text={t( "FILTER-BY-A-USER" )}
                  onPress={() => {
                    setOpenPicker( "user" );
                  }}
                  accessibilityLabel={t( "Filter" )}
                />
              )}
            </View>
            {currentUser && (
              <Checkbox
                text={t( "Faved-by-me-observations-filter" )}
                isChecked={!!favedByMe}
                onPress={() => dispatch( { type: "TOGGLE_FAVED_BY_ME" } )}
              />
            )}
          </View>

          {/* Project Section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "PROJECT" )}</Heading4>
            <View className="mb-5">
              {displayProject
                ? (
                  <SelectedFilterRow
                    accessibilityLabel={t( "Change-project" )}
                    onEdit={() => setOpenPicker( "project" )}
                    onRemove={() => updateProject( null )}
                    removeAccessibilityLabel={t( "Remove-project-filter" )}
                  >
                    <ProjectListItem item={displayProject} />
                  </SelectedFilterRow>
                )
                : (
                  <Button
                    text={t( "FILTER-BY-A-PROJECT" )}
                    onPress={() => {
                      setOpenPicker( "project" );
                    }}
                    accessibilityLabel={t( "Filter" )}
                  />
                )}
            </View>
          </View>

          {/* Taxonomic Ranks section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "TAXONOMIC-RANKS" )}</Heading4>
            <Body2 className="ml-1 mb-3">{t( "Highest" )}</Body2>
            <Button
              text={hrank
                ? taxonomicRankValues[hrank]?.label
                : t( "ALL" )}
              className="shrink mb-7"
              dropdown
              onPress={() => {
                setOpenSheet( "hrank" );
              }}
              accessibilityLabel={t( "Highest" )}
            />
            <Body2 className="ml-1 mb-3">{t( "Lowest" )}</Body2>
            <Button
              text={lrank
                ? taxonomicRankValues[lrank]?.label
                : t( "ALL" )}
              className="shrink mb-7"
              dropdown
              onPress={() => {
                setOpenSheet( "lrank" );
              }}
              accessibilityLabel={t( "Lowest" )}
            />
          </View>

          {/* Date observed section */}
          <DateFilterSection
            headerText={t( "DATE-OBSERVED" )}
            accessibilityLabel={t( "Date-observed" )}
            modeValues={dateObservedValues}
            mode={dateObserved}
            onChangeMode={newDateObserved => updateDateObserved( {
              // Carry existing dates through the mode switch so flipping modes
              // (e.g. Exact -> Range -> Exact) doesn't reset them to today.
              newDateObserved,
              newObservedOn: observedOn,
              newD1: d1,
              newD2: d2,
              newMonths: months,
            } )}
            exactMode={DATE_OBSERVED.EXACT_DATE}
            exactDate={observedOn}
            onChangeExactDate={newObservedOn => updateDateObserved( {
              newDateObserved: DATE_OBSERVED.EXACT_DATE,
              newObservedOn,
            } )}
            rangeMode={DATE_OBSERVED.DATE_RANGE}
            rangeStart={d1}
            rangeEnd={d2}
            rangeEndBeforeStart={observedEndBeforeStart}
            onChangeRangeStart={newD1 => updateDateObserved( {
              newDateObserved: DATE_OBSERVED.DATE_RANGE,
              newD1,
              newD2: d2,
            } )}
            onChangeRangeEnd={newD2 => updateDateObserved( {
              newDateObserved: DATE_OBSERVED.DATE_RANGE,
              newD1: d1,
              newD2,
            } )}
          >
            {dateObserved === DATE_OBSERVED.MONTHS
            && Object.keys( monthValues ).map( monthKey => (
              <View key={monthKey} className="flex-row items-center mb-5">
                <Checkbox
                  text={monthValues[monthKey].label}
                  isChecked={( months || [] ).includes( monthValues[monthKey].value )}
                  onPress={() => updateObservedMonths( monthValues[monthKey].value )}
                />
              </View>
            ) )}
          </DateFilterSection>

          {/* Date uploaded section */}
          <DateFilterSection
            headerText={t( "DATE-UPLOADED" )}
            accessibilityLabel={t( "Date-uploaded" )}
            modeValues={dateUploadedValues}
            mode={dateUploaded}
            onChangeMode={newDateUploaded => updateDateUploaded( {
              // Carry existing dates through the mode switch so flipping modes
              // doesn't reset them to today
              newDateUploaded,
              newD1: newDateUploaded === DATE_UPLOADED.EXACT_DATE
                ? createdOn
                : createdD1,
              newD2: createdD2,
            } )}
            exactMode={DATE_UPLOADED.EXACT_DATE}
            exactDate={createdOn}
            onChangeExactDate={newD1 => updateDateUploaded( {
              newDateUploaded: DATE_UPLOADED.EXACT_DATE,
              newD1,
            } )}
            rangeMode={DATE_UPLOADED.DATE_RANGE}
            rangeStart={createdD1}
            rangeEnd={createdD2}
            rangeEndBeforeStart={uploadedEndBeforeStart}
            onChangeRangeStart={newD1 => updateDateUploaded( {
              newDateUploaded: DATE_UPLOADED.DATE_RANGE,
              newD1,
              newD2: createdD2,
            } )}
            onChangeRangeEnd={newD2 => updateDateUploaded( {
              newDateUploaded: DATE_UPLOADED.DATE_RANGE,
              newD1: createdD1,
              newD2,
            } )}
          />

          {/* Media section */}
          <RadioGroupSection
            headerText={t( "MEDIA" )}
            values={getMediaValues( t )}
            selectedValue={media}
            onChange={newMedia => dispatch( { type: "SET_MEDIA", media: newMedia } )}
          />

          {/* Establishment Means section */}
          <RadioGroupSection
            headerText={t( "ESTABLISHMENT-MEANS" )}
            values={getEstablishmentValues( t )}
            selectedValue={establishmentMean}
            onChange={newEstablishmentMean => dispatch( {
              type: "SET_ESTABLISHMENT_MEAN",
              establishmentMean: newEstablishmentMean,
            } )}
          />

          {/* Wild Status section */}
          <RadioGroupSection
            headerText={t( "WILD-STATUS" )}
            values={getWildValues( t )}
            selectedValue={wildStatus}
            onChange={newWildStatus => dispatch( {
              type: "SET_WILD_STATUS",
              wildStatus: newWildStatus,
            } )}
          />

          {/* Evidence Type section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "EVIDENCE-TYPE" )}</Heading4>
            {Object.values( getEvidenceTypeValues( t ) ).map( ( { label, value } ) => (
              <View key={value} className="mb-4">
                <Checkbox
                  text={label}
                  isChecked={!!evidenceTypes?.includes( value )}
                  onPress={() => dispatch( { type: "TOGGLE_EVIDENCE_TYPE", evidenceType: value } )}
                />
              </View>
            ) )}
          </View>

          {/* Reviewed section */}
          {currentUser && (
            <RadioGroupSection
              headerText={t( "REVIEWED" )}
              values={getReviewedValues( t )}
              selectedValue={reviewedFilter}
              onChange={newReviewedFilter => dispatch( {
                type: "SET_REVIEWED",
                reviewedFilter: newReviewedFilter,
              } )}
            />
          )}

          {/* Photo licensing section */}
          <View>
            <Heading4 className="mb-5">{t( "PHOTO-LICENSING" )}</Heading4>
            <Button
              text={photoLicenseValues[photoLicense]?.label}
              className="shrink mb-7"
              dropdown
              onPress={() => {
                setOpenSheet( "photoLicense" );
              }}
              accessibilityLabel={t( "View-photo-licensing-info" )}
            />
          </View>

        </View>
      </NestableScrollContainer>
      <ButtonBar containerClass="bg-white border-t border-lightGray">
        <Button
          disabled={hasError}
          level={differsFromInitial
            ? "focus"
            : "primary"}
          text={t( "SEARCH" )}
          onPress={handleSearch}
          accessibilityLabel={t( "Search" )}
          accessibilityState={{ disabled: hasError }}
          testID="AdvancedSearch.searchButton"
        />
      </ButtonBar>

      {/* BottomSheets */}
      {openSheet === "hrank" && (
        <PickerSheet
          headerText={t( "HIGHEST-RANK" )}
          confirm={newRank => {
            dispatch( {
              type: "SET_HRANK",
              hrank: newRank,
            } );
            closeSheet();
          }}
          onPressClose={closeSheet}
          pickerValues={taxonomicRankValues}
          selectedValue={hrank}
        />
      )}
      {openSheet === "lrank" && (
        <PickerSheet
          headerText={t( "LOWEST-RANK" )}
          confirm={newRank => {
            dispatch( {
              type: "SET_LRANK",
              lrank: newRank,
            } );
            closeSheet();
          }}
          onPressClose={closeSheet}
          pickerValues={taxonomicRankValues}
          selectedValue={lrank}
        />
      )}
      {openSheet === "photoLicense" && (
        <RadioButtonSheet
          headerText={t( "PHOTO-LICENSING" )}
          confirm={newLicense => {
            dispatch( {
              type: "SET_PHOTO_LICENSE",
              photoLicense: newLicense,
            } );
            closeSheet();
          }}
          onPressClose={closeSheet}
          radioValues={photoLicenseValues}
          selectedValue={photoLicense}
        />
      )}
      {openSheet === "excludeSavedSearch" && (
        <RadioButtonSheet
          headerText={t( "EXCLUDE-SPECIES-IN-A-SAVED-SEARCH" )}
          confirm={( name: string ) => {
            updateExcludeSpeciesInSavedSearch( name );
            closeSheet();
          }}
          onPressClose={closeSheet}
          radioValues={excludeSavedSearchValues}
          selectedValue={excludeSpeciesInSavedSearch ?? ""}
        />
      )}
      {openPicker === "taxon" && (
        <ExploreTaxonSearchModal
          showModal
          closeModal={closePicker}
          taxonFilters={taxonFilters}
          updateTaxonFilters={updateTaxonFilters}
        />
      )}
      {openPicker === "user" && (
        <ExploreUserSearchModal
          showModal
          closeModal={closePicker}
          updateUser={updateUser}
          defaultToCurrentUser
        />
      )}
      {openPicker === "project" && (
        <ExploreProjectSearchModal
          showModal
          closeModal={closePicker}
          updateProject={updateProject}
        />
      )}
      {openPicker === "location" && (
        <ExploreLocationSearchModal
          showModal
          closeModal={closePicker}
          nearbyRadius={{
            selected: isNearby,
            radiusKm: nearbyRadiusKm,
            defaultRadiusKm: DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM,
            onChange: setNearby,
          }}
          onSelectNearby={() => setNearby( )}
          updateLocation={updateLocation}
        />
      )}
      <SavedSearchSheets
        currentSearch={currentSavedSearch}
        onCloseDelete={( ) => setSearchToDelete( null )}
        onCloseSave={( ) => setShowSaveSheet( false )}
        searchToDelete={searchToDelete}
        showSaveSheet={showSaveSheet}
      />
      {pendingExit && (
        <WarningSheet
          onPressClose={( ) => setPendingExit( false )}
          confirm={( ) => {
            setPendingExit( false );
            navigation.goBack( );
          }}
          headerText={t( "DISCARD-FILTER-CHANGES" )}
          text={t( "You-changed-filters-will-be-discarded" )}
          buttonText={t( "DISCARD-CHANGES" )}
          handleSecondButtonPress={( ) => setPendingExit( false )}
          secondButtonText={t( "CANCEL" )}
          loading={false}
        />
      )}
    </SharedStackViewWrapper>
  );
};

export default AdvancedSearch;
