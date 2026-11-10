import {
  addDays, differenceInCalendarDays, format, parseISO,
} from "date-fns";
import type { ExploreV2Filters } from "providers/ExploreV2Context";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";

const DATE_FIELDS = [
  "observed_on",
  "d1",
  "d2",
  "created_on",
  "created_d1",
  "created_d2",
] as const satisfies readonly ( keyof ExploreV2Filters )[];

export const isoDay = ( date: Date | number ): string => format( date, "yyyy-MM-dd" );

// Saved dates are relative to the day the search was saved, so a search saved for "today"
// shows today's observations when it's opened tomorrow. Searches saved before datesAsOf
// existed are anchored to the day they were saved.
const relativeSavedSearch = (
  search: SavedSearch,
  today: Date = new Date( ),
): SavedSearch => {
  const anchor = search.datesAsOf
    ? parseISO( search.datesAsOf )
    : new Date( search.savedAt );
  const offset = differenceInCalendarDays( today, anchor );
  if ( offset === 0 || Number.isNaN( offset ) ) { return search; }

  const filters = { ...search.filters };
  let shifted = false;
  DATE_FIELDS.forEach( field => {
    const value = filters[field];
    if ( !value ) { return; }
    const date = parseISO( value );
    if ( Number.isNaN( date.getTime( ) ) ) { return; }
    filters[field] = isoDay( addDays( date, offset ) );
    shifted = true;
  } );
  return shifted
    ? { ...search, filters }
    : search;
};

export default relativeSavedSearch;
