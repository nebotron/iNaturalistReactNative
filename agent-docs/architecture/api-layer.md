# API Layer Architecture

## Overview

Wrapper-based API abstraction built on `inaturalistjs`, combined with React Query for state management. All API responses are transformed to match Realm schemas before storage. Custom error handling with retry strategies and Grafana logging.

## Key Files

| File | Purpose |
|------|---------|
| `src/api/observations.ts` | Observation CRUD, search, faves, subscriptions (see its `export` block for the full list) |
| `src/api/taxa.ts` | Taxon fetch and search with field optimization |
| `src/api/users.ts` | User profiles, blocking/muting |
| `src/api/projects.ts` | Project search, membership |
| `src/api/search.ts` | Cross-resource search |
| `src/api/error.ts` | Custom error classes (INatApiError, 401, 429) and handleError |
| `src/api/types.d.ts` | TypeScript interfaces for API responses |
| `src/api/log/index.ts` | `iNatLogstashTransport` — posts logs to the iNaturalist API log endpoint (surfaced downstream in Grafana) |
| `src/sharedHooks/useAuthenticatedQuery.ts` | React Query wrapper with JWT injection |
| `src/sharedHooks/useAuthenticatedMutation.ts` | Mutation wrapper with JWT + 401/429 handling |
| `src/sharedHooks/useAuthenticatedInfiniteQuery.ts` | Infinite query wrapper for pagination |
| `src/sharedHooks/useQuery.ts` | Non-authenticated query wrapper |
| `src/sharedHelpers/logging.js` | Retry logic and delay strategies |

## Standard API Wrapper Pattern

Every API module follows this pattern:

```javascript
import inatjs from "inaturalistjs";
import handleError from "./error";

const searchObservations = async ( params = {}, opts = {} ) => {
  try {
    const response = await inatjs.observations.search( params, opts );
    response.results = response.results.map( mapToLocalSchema );
    return response;
  } catch ( e ) {
    return handleError( e, { context: { functionName: "searchObservations" } } );
  }
};
```

Rules:
- ALL calls go through wrapper functions (never call inaturalistjs directly from components)
- Every call wrapped in try-catch with `handleError`
- Responses transformed to Realm-compatible schema before returning
- `params` = query/body data, `opts` = options including `api_token`

## React Query Hooks

### useAuthenticatedQuery
```typescript
const { data, error, isLoading, refetch } = useAuthenticatedQuery(
  ["fetchTaxon", taxonId],
  optsWithAuth => fetchTaxon( taxonId, params, optsWithAuth ),
  { enabled },
);
```
- Waits for auth state before executing
- Injects JWT via `getJWT(allowAnonymousJWT)`
- Includes auth state in query key for cache separation
- Custom retry logic per status code

### useAuthenticatedMutation
```typescript
const { mutate } = useAuthenticatedMutation(
  ( faveParams, optsWithAuth ) => faveObservation( faveParams, optsWithAuth ),
  { onSuccess: () => { /* ... */ }, onError: ( error ) => { /* ... */ } },
);
mutate( { uuid } );
```
- Auto-injects JWT
- Smart 401 handling: logs context, attempts token refresh
- Smart 429 handling: logs the error (no automatic retry/backoff on mutations — exponential backoff applies to the query path only; see `logging.js`)

### useAuthenticatedInfiniteQuery
```typescript
const { data, fetchNextPage, isFetchingNextPage } = useAuthenticatedInfiniteQuery(
  queryKey,
  async ( params, optsWithAuth ) => searchObservations( { ...baseParams, ...params }, optsWithAuth ),
  { getNextPageParam, enabled },
);
const observations = flatten( data?.pages?.map( r => r.results ) ) || [];
```

**Cacheable results (`cacheable: true`).** Explore's lists (`useInfiniteExploreScroll`, and
`useInfiniteScroll` in the Species, Observers and Identifiers views) pass `cacheable: true`.
Their results stay in memory for 48 hours (`staleTime` and `gcTime`), so leaving Explore
and coming back shows them without fetching again. Across a restart they come from the
platform's HTTP cache (`NSURLCache` on iOS, OkHttp's cache on Android), which stores the
raw responses natively for as long as the API's `Cache-Control` allows (`max-age=300`,
then revalidated with the `ETag`). Pages are never serialized in JS. That only works
because these requests leave out `ttl: -1`, which makes the API answer
`private, no-cache, no-store`; every other API call still sends it. A URL over 2,000
characters is sent by inaturalistjs as a POST, which no HTTP cache stores, so keep
`fields` for these lists small.

Offline, cacheable queries still run (`networkMode: "offlineFirst"`) and send
`Cache-Control: only-if-cached, max-stale=<30 days>`, so the HTTP cache answers with
whatever it holds without touching the network. OkHttp honors that on Android; on iOS,
`AppDelegate.mm` maps it to `NSURLRequestReturnCacheDataDontLoad` with
`RCTSetCustomHTTPRequestInterceptor` (NSURLSession ignores request cache directives) and
sizes the shared `NSURLCache` at 50 MB. Results served that way are fetched again when
the connection comes back.

The key of a cacheable query holds the user's id, locale and name preferences instead of
the whole user object, whose counts change constantly and would restart the query.

The hook also returns `refreshFirstPage( )`, which fetches the first page (with `ttl: -1`,
so the API answers afresh rather than the HTTP cache) and replaces
every page with it only if that works. It throws on failure and leaves the data as it
was. Pull to refresh uses it instead of `removeQueries` + `refetch`, which emptied the list
first and left it empty if the request failed.

### useNonAuthenticatedQuery (useQuery.ts)
For public endpoints that don't need JWT.

## Query Key Conventions

Format: `[domain, ...identifiers]`

```javascript
["fetchTaxon", taxonId]
["fetchQualityMetrics", observationUUID]
["useInfiniteExploreScroll", { ...filterParams }]
["fetchSearchResults", locationName]
```

Auth state appended automatically by hooks: `[...queryKey, allowAnonymousJWT, userLoggedIn]`

## Response Transformation

Two-stage process:
1. **API wrapper** normalizes common fields (e.g., `license_code` → `licenseCode`)
2. **Realm model mapper** applies domain logic (e.g., `Taxon.mapApiToRealm()`)

## Error Handling

### Error Classes (`src/api/error.ts`)
- `INatApiError` — Base class with json, status, context
- `INatApiUnauthorizedError` — 401 errors
- `INatApiTooManyRequestsError` — 429 errors

### Retry Strategy (`src/sharedHelpers/logging.js`)

| Status | Behavior |
|--------|----------|
| 429 (Rate limit) | Exponential backoff + jitter, retry 3x |
| 401/403 (Auth) | Token refresh attempt, retry 2x |
| 404 (Not found) | No retry |
| 408 / Network error | Retry 3x |
| Others | Retry 2x |

### Retry Delay
- 429: `1000 * 2^failureCount + random(0-100)ms`
- Others: `min(1000 * 2^failureCount, 30000ms)`

## Field Filtering

API calls specify exact fields to reduce payload:
```javascript
const FIELDS = {
  ancestor_ids: true,
  default_photo: { url: true },
  name: true,
  preferred_common_name: true,
  rank: true,
  rank_level: true,
};
```

## Common Operations

### Adding a new API endpoint
1. Create wrapper function in appropriate `src/api/*.js` file following the standard pattern
2. Create React Query hook using `useAuthenticatedQuery` or `useAuthenticatedMutation`
3. Transform response to match Realm schema if persisting locally
4. Add TypeScript types to `src/api/types.d.ts` if needed

### Adding a new React Query hook
1. Choose the right base hook: `useAuthenticatedQuery` (read), `useAuthenticatedMutation` (write), `useAuthenticatedInfiniteQuery` (paginated list)
2. Define a descriptive query key including relevant identifiers
3. Pass the API wrapper function with auth options
4. Handle errors in `onError` callback for mutations
