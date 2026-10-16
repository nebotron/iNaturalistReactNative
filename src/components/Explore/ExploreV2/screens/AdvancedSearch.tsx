import { useNetInfo } from "@react-native-community/netinfo";
import { useNavigation } from "@react-navigation/native";
import type { ApiPlace, ApiProjectSummary } from "api/types";
import { OBSERVATIONS_TAB } from "appConstants/tabs";
import ExploreTaxonFiltersSection from "components/Explore/ExploreTaxonFiltersSection";
import DateFilterSection
  from "components/Explore/ExploreV2/components/DateFilterSection";
import HotspotSettingsSection
  from "components/Explore/ExploreV2/components/HotspotSettingsSection";
import RadioGroupSection
  from "components/Explore/ExploreV2/components/RadioGroupSection";
import SavedSearches, { SavedSearchSheets }
  from "components/Explore/ExploreV2/components/SavedSearches";
import SelectedFilterRow
  from "components/Explore/ExploreV2/components/SelectedFilterRow";
import {
  getDateObservedValues,
  getDateUploadedValues,
  getEstablishmentValues,
  getEvidenceTypeValues,
  getMediaValues,
  getMonthValues,
  getPhotoLicenseValues,
  getReviewedValues,
  getSortByValues,
  getTaxonomicRankValues,
  getWildValues,
} from "components/Explore/ExploreV2/helpers/advancedSearchOptions";
import {
  advancedSearchReducer,
  defaultAdvancedSearchDraft,
  draftFromV2State,
  searchTaxonFilters,
} from "components/Explore/ExploreV2/helpers/advancedSearchReducer";
import buildExploreV2QueryParams
  from "components/Explore/ExploreV2/helpers/buildQueryParams";
import locationLabel from "components/Explore/ExploreV2/helpers/locationLabel";
import useApplySavedSearch from "components/Explore/ExploreV2/hooks/useApplySavedSearch";
import type { ExploreTaxonFilter } from "components/Explore/helpers/taxonFilters";
import { toggleTaxonFilter } from "components/Explore/helpers/taxonFilters";
import ExploreLocationSearchModal from "components/Explore/Modals/ExploreLocationSearchModal";
import ExploreProjectSearchModal from "components/Explore/Modals/ExploreProjectSearchModal";
import ExploreTaxonSearchModal from "components/Explore/Modals/ExploreTaxonSearchModal";
import ExploreUserSearchModal from "components/Explore/Modals/ExploreUserSearchModal";
import { SaveOfflineButton } from "components/Explore/OfflineExplore";
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
import { ScrollView, View } from "components/styledComponents";
import UserListItem from "components/UserList/UserListItem";
import isEqual from "lodash/isEqual";
import type { ExploreStackScreenProps } from "navigation/types";
import {
  DATE_OBSERVED,
  DATE_UPLOADED,
} from "providers/ExploreContext";
import {
  EXPLORE_V2_ACTION,
  EXPLORE_V2_PLACE_MODE,
  useExploreV2,
} from "providers/ExploreV2Context";
import React, { useMemo, useReducer, useState } from "react";
import { formatObsFieldDate } from "sharedHelpers/dateAndTime";
import { DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM } from "sharedHelpers/nearbyRadius";
import { useCurrentUser, useTranslation } from "sharedHooks";
import useIconicTaxa from "sharedHooks/useIconicTaxa";
import useStoredLayout from "sharedHooks/useStoredLayout";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";

// Please don't change these to aliased paths or the e2e mocks will not get used
import fetchCoarseUserLocation from "../../../../sharedHelpers/fetchCoarseUserLocation";
import { getLatestTrackedLocation } from "../../../../sharedHelpers/locationHistoryTracker";

type SheetName = "sortBy" | "hrank" | "lrank" | "photoLicense";

type PickerKind = "taxon" | "user" | "project" | "location";

const ALL_MONTHS = new Array( 12 ).fill( 0 ).map( ( _, i ) => i + 1 );

const isoToday = ( ) => formatObsFieldDate( new Date( ) );

const AdvancedSearch = ( ) => {
  const navigation
    = useNavigation<ExploreStackScreenProps<"AdvancedSearch">["navigation"]>();
  const { t } = useTranslation();
  const iconicTaxa = useIconicTaxa();
  const currentUser = useCurrentUser();
  const { isConnected } = useNetInfo( );

  const { state: v2State, dispatch: dispatchV2 } = useExploreV2();
  const applySavedSearch = useApplySavedSearch( );
  const [initialDraft] = useState( ( ) => draftFromV2State( v2State ) );
  const [draft, dispatch] = useReducer( advancedSearchReducer, initialDraft );
  const {
    subject, location, sortBy, filters,
  } = draft;

  const differsFromInitial = useMemo(
    ( ) => !isEqual( draft, initialDraft ),
    [draft, initialDraft],
  );

  const resetDisabled = useMemo(
    ( ) => isEqual( draft, defaultAdvancedSearchDraft ),
    [draft],
  );

  const { layout: observationsLayout } = useStoredLayout( "exploreV2ObservationsLayout" );
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

  const updateUnobservedByUser = ( selectedUser: ExploreSearchUser | null ) => dispatch( {
    type: "SET_UNOBSERVED_BY_USER",
    user: selectedUser && {
      id: selectedUser.id,
      login: selectedUser.login,
      icon_url: selectedUser.icon_url,
    },
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

  const isNearby = location.placeMode === EXPLORE_V2_PLACE_MODE.NEARBY;
  const nearbyRadiusKm = ( isNearby && location.radius ) || DEFAULT_EXPLORE_V2_NEARBY_RADIUS_KM;
  const setNearby = ( radius = nearbyRadiusKm ) => dispatch( {
    type: "SET_LOCATION_NEARBY",
    radius,
  } );

  // API params for the search as drafted, for saving its results offline
  const getOfflineQueryParams = async ( ) => {
    let nearbyCoords;
    if ( isNearby ) {
      const coords = await getLatestTrackedLocation( ) ?? await fetchCoarseUserLocation( );
      if ( typeof coords?.latitude !== "number" ) throw new Error( "No location" );
      nearbyCoords = { lat: coords.latitude, lng: coords.longitude };
    }
    const search = { ...v2State, ...currentSearch };
    return { ...buildExploreV2QueryParams( search, nearbyCoords, currentUser?.id ) };
  };

  const handleSearch = () => {
    dispatchV2( { type: EXPLORE_V2_ACTION.APPLY_SEARCH, search: currentSearch } );
    dispatchV2( { type: EXPLORE_V2_ACTION.SET_ACTIVE_TAB, tab: OBSERVATIONS_TAB } );
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
    popular,
    project,
    researchGrade,
    reviewedFilter,
    unobservedByUser,
    user,
    wildStatus,
  } = filters;

  const taxonFilters = searchTaxonFilters( subject, filters );
  const taxonUnknown = subject?.type === "unknown";
  const chosenIconicTaxa = taxonUnknown
    ? ["unknown"]
    : taxonFilters
      .filter( filter => !filter.exclude )
      .map( filter => filter.taxon.name?.toLowerCase( ) )
      .filter( ( name ): name is string => !!name );

  const displayProject = project;

  const sortByValues = getSortByValues( t );
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
        months: newMonths || ALL_MONTHS,
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
  const hasError = observedEndBeforeStart || uploadedEndBeforeStart || noMonthsSelected;

  return (
    <SharedStackViewWrapper testID="AdvancedSearch">
      <SearchHeader
        headerText={t( "SEARCH" )}
        onClose={requestExit}
        onReset={() => dispatch( { type: "RESET" } )}
        resetDisabled={resetDisabled}
        testID="AdvancedSearch.back"
      />

      <ScrollView className="py-4">
        <SavedSearches
          currentSearch={currentSavedSearch}
          onDelete={setSearchToDelete}
          onSave={( ) => setShowSaveSheet( true )}
          onSelect={applySavedSearch}
        />
        <SaveOfflineButton
          disabled={isConnected === false || hasError}
          getQueryParams={getOfflineQueryParams}
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
            before
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
          {currentUser && (
            <View className="px-4 mt-5">
              <Checkbox
                text={t( "Unobserved-by-me" )}
                isChecked={!!unobservedByUser}
                onPress={() => updateUnobservedByUser( unobservedByUser
                  ? null
                  : currentUser )}
              />
            </View>
          )}
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

          {/* Sort-By Section */}
          <View className="mb-7">
            <Heading4 className="mb-5">{t( "SORT-BY" )}</Heading4>
            <View className="mb-5">
              <Button
                text={sortByValues[sortBy]?.labelCaps}
                className="shrink"
                dropdown
                onPress={() => {
                  setOpenSheet( "sortBy" );
                }}
                accessibilityLabel={t( "Sort-by" )}
              />
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
            <Checkbox
              text={t( "Popular-observations-filter" )}
              isChecked={!!popular}
              onPress={() => dispatch( { type: "TOGGLE_POPULAR" } )}
            />
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

          <HotspotSettingsSection />
        </View>
      </ScrollView>
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
      {openSheet === "sortBy" && (
        <RadioButtonSheet
          headerText={t( "SORT-BY" )}
          confirm={newSortBy => {
            dispatch( {
              type: "SET_SORT",
              sortBy: newSortBy,
            } );
            closeSheet();
          }}
          onPressClose={closeSheet}
          radioValues={sortByValues}
          selectedValue={sortBy}
        />
      )}
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
