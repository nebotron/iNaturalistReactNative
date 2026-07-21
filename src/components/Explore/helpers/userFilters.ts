export interface ExploreUserFilter {
  user: {
    id: number;
    login: string;
    name?: string;
    icon_url?: string;
    observations_count?: number;
  };
  exclude: boolean;
}

interface UserLike {
  id?: number;
  login?: string;
  name?: string;
  icon_url?: string;
  observations_count?: number;
}

export function toExploreUserFilterUser(
  user: UserLike | null | undefined,
): ExploreUserFilter["user"] {
  if ( !user?.id ) {
    throw new Error( "Cannot store user filter without user id" );
  }
  return {
    id: user.id,
    login: user.login || "",
    name: user.name,
    icon_url: user.icon_url,
    observations_count: user.observations_count,
  };
}

export function normalizeUserFilters(
  userFilters: ExploreUserFilter[] | undefined,
): ExploreUserFilter[] {
  return ( userFilters || [] )
    .map( filter => ( {
      exclude: filter.exclude,
      user: toExploreUserFilterUser( filter.user ),
    } ) )
    .filter( filter => filter.user?.id );
}

export function migrateUserFilters(
  storedState: {
    user?: UserLike | null;
    user_id?: number | null;
    excludeUser?: UserLike | null;
    userFilters?: ExploreUserFilter[];
  },
): ExploreUserFilter[] {
  if ( storedState.userFilters?.length ) {
    return normalizeUserFilters( storedState.userFilters );
  }
  if ( storedState.user?.id ) {
    return [{ user: toExploreUserFilterUser( storedState.user ), exclude: false }];
  }
  if ( storedState.excludeUser?.id ) {
    return [{ user: toExploreUserFilterUser( storedState.excludeUser ), exclude: true }];
  }
  return [];
}

export function userFiltersToApiParams(
  userFilters: ExploreUserFilter[] | undefined,
): {
  user_id?: number | string;
} {
  const includeIds = ( userFilters || [] )
    .filter( filter => !filter.exclude )
    .map( filter => filter.user.id );

  const params: { user_id?: number | string } = {};

  if ( includeIds.length === 1 ) {
    params.user_id = includeIds[0];
  } else if ( includeIds.length > 1 ) {
    params.user_id = includeIds.join( "," );
  }

  return params;
}

export function toggleUserFilter(
  userFilters: ExploreUserFilter[],
  user: ExploreUserFilter["user"] | UserLike,
  exclude = false,
): ExploreUserFilter[] {
  const normalizedUser = toExploreUserFilterUser( user );
  const existingIndex = userFilters.findIndex(
    filter => filter.user.id === normalizedUser.id,
  );

  if ( existingIndex >= 0 ) {
    const existing = userFilters[existingIndex];
    if ( existing.exclude === exclude ) {
      return userFilters.filter( filter => filter.user.id !== normalizedUser.id );
    }
    return userFilters.map( ( filter, index ) => (
      index === existingIndex
        ? { user: normalizedUser, exclude }
        : filter
    ) );
  }

  return [...userFilters, { user: normalizedUser, exclude }];
}

export function removeUserFilter(
  userFilters: ExploreUserFilter[],
  userId: number,
): ExploreUserFilter[] {
  return userFilters.filter( filter => filter.user.id !== userId );
}
