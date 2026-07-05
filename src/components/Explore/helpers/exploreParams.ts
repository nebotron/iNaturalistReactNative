// Collection of helpers that help prepare API request parameters

import type {
  ApiObservationsSearchParams,
  ApiObservationsSearchResponse,
} from "api/types";
import last from "lodash/last";

interface DatePageParam {
  date: string;
  id: number;
}

interface ApiObservationsSearchParamsForInfiniteQuery extends ApiObservationsSearchParams {
  pageParam: number | string | DatePageParam | undefined | null;
}

// Gets the next page param for Explore given the last page
//
// Pagination using our API is complicated. The page param will only work
// for the first 10k results. Frequently-updated result sets (like the
// default), can potentially show duplicate observations on subsequent
// pages using the page param as well. To avoid both of those issues, we're
// paginating results using the id_below / id_above or d1 / d2 params when
// possible, i.e. when sorting by date created or date observed. Other
// sorts must use the page param and suffer the limitations described
// above.
function getNextPageParamForExplore(
  lastPage: ApiObservationsSearchResponse,
  params: ApiObservationsSearchParams,
) {
  const lastObs = last( lastPage.results );
  const orderBy = params.order_by;

  // Returning null tells useInfiniteQuery there is no next page, so the
  // query method should not even run. If there are no observations in the
  // results, we're done and can stop requesting new pages.
  if ( !lastObs ) return null;

  // Datetime sorts need to use d1 / d2 or created_d1 / created_d2 to
  // paginate results, so we're storing a datetime from the last observation
  // as the "page" and we'll use that to adjust the query when we perform
  // it. We also carry along the last observation's id as a tiebreaker
  // (combined with id_below / id_above in addPageParamsForExplore) so
  // pagination still makes forward progress when many observations share
  // the exact same timestamp (e.g. bulk imports) instead of getting stuck
  // re-requesting the same date boundary forever.
  if ( ["observed_on", "created_at"].includes( String( orderBy ) ) ) {
    const lastObsDate = orderBy === "observed_on"
      ? lastObs?.time_observed_at
      : lastObs?.created_at;

    // If there are results but the last one doesn't have a datetime or id,
    // we're also done... but this is probably impossible.
    if ( !lastObsDate || lastObs.id == null ) {
      return null;
    }

    return { date: lastObsDate, id: lastObs.id };
  }

  // Any sort that isn't observed_on or created_at and isn't the default
  // (blank, meaning created_at) should use basic pagination.
  if ( typeof ( orderBy ) === "string" ) {
    return lastPage.page + 1;
  }

  // If we got here that means orderBy is undefined or null, i.e. the
  // default sort order by id
  return lastObs?.id;
}

// Actually modifieds the Explore API params before the request to include the
// page params
function addPageParamsForExplore( params: ApiObservationsSearchParamsForInfiniteQuery ) {
  const { pageParam } = params;
  const newParams = { ...params };

  // For the purposes of Explore, an undefined page or a page of 0 is the
  // default state before any data has loaded, so those values mean we're
  // requesting the first page
  const requestingFirstPage = typeof ( pageParam ) === "undefined" || pageParam === 0;
  if ( requestingFirstPage ) {
    // For the first page and only for the first page, we need to retrieve
    // the georaphic bounds of the results so we can pan and zoom the map
    // to contain them
    newParams.return_bounds = true;
  } else if (
    newParams.order_by === "observed_on"
    && typeof ( pageParam ) === "object"
    && pageParam
  ) {
    // If we're ordering by date observed, we are "paginating" by date
    // (with the last observation's id as a tiebreaker, since many
    // observations can share the same date) and getNextPageParam will
    // have set the pageParam accordingly
    if ( params.order === "asc" ) {
      newParams.d1 = pageParam.date;
      newParams.id_above = pageParam.id;
    } else {
      newParams.d2 = pageParam.date;
      newParams.id_below = pageParam.id;
    }
  } else if (
    newParams.order_by === "created_at"
    && typeof ( pageParam ) === "object"
    && pageParam
  ) {
    // If we're ordering by date created, we are "paginating" by date
    // (with the last observation's id as a tiebreaker, since many
    // observations can share the same date) and getNextPageParam will
    // have set the pageParam accordingly
    if ( params.order === "asc" ) {
      newParams.created_d1 = pageParam.date;
      newParams.id_above = pageParam.id;
    } else {
      newParams.created_d2 = pageParam.date;
      newParams.id_below = pageParam.id;
    }
  } else if ( typeof ( newParams.order_by ) === "string" && typeof ( pageParam ) === "number" ) {
    // If this is any kind of sort other than the date sorts and isn't the
    // default (blank), assume basic pagination using the page param
    newParams.page = pageParam;
  } else {
    // If we're using default sort order by id, getNextPageParam will have
    // set pageParam to a serial id
    newParams.id_below = Number( pageParam );
  }
  return newParams;
}

export {
  addPageParamsForExplore,
  getNextPageParamForExplore,
};
