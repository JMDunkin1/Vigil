# Instagram friendship reader correction — October 26, 2026

The phone was current when the user reported that only informational exceptions
were visible. This was not an outdated installation. The original relationship
fixtures incorrectly modeled Instagram's Relay query result as plain account
data. The real `PolarisSearchBoxRefetchableQuery.graphql` reader fragment contains
only a fragment spread. Relay's `fetchQuery` returns the reader's masked fragment
reference, so accessing `payload.xdt_api__v1__fbsearch__topsearch_connection.users`
on that reference does not work.

The correction supplies a reader fragment with the fields already in the loaded
query's normalization operation. It leaves the persisted query parameters,
normalization operation, and network variables unchanged. Missing modules are
loaded through Instagram's own Bootloader, with shared bounded lookup promises.
The existing exact-username match, two-direction follow proof, informational
exceptions, viewer-scoped cache, and fail-closed behavior remain.

The response and reader behavior were checked against Instagram's publicly
served `PolarisSearchBoxRefetchableQuery.graphql`,
`relay-runtime/query/fetchQuery`, and
`relay-runtime/store/RelayModernOperationDescriptor` modules. No new endpoint,
persisted GraphQL ID, authentication token, or entitlement was introduced.

Bounded local diagnostics retain stage/status/schema counters and Home
classification totals. They do not retain account names, tokens, cookies, URLs,
or response bodies. This made it possible to verify the installed release
without changing inspection or enforcement settings.

## Validation and deployment

- 25 targeted native simulator tests passed, including a masked-reader fixture
  and deferred-module loading without legacy REST. A combined run with the
  parallel native-pan change passed all 29 selected tests.
- Lint, build, social-build contracts, 48 native route probes, and whitespace
  checks passed.
- The normal `agent:update:social` transaction in the parallel swipe-guard chat
  installed both commits in Vigil 0.3.197 (200). The exact live supervised policy
  remained current (`4e6da9b09d55…`), signing remained Personal Team, and all
  companion launches were verified. No second competing update was started.
- Read-only extraction of the live WebKit local-storage database showed 20
  newly checked account records: 12 mutual friends and 8 nonmutual accounts.
  Every timestamp was between 2026-10-26 17:44:06 and 17:45:07 UTC, following the
  update. Informational exceptions do not enter that friendship cache, so the
  12 positive records establish that ordinary friend verification is working
  on the physical phone.
- Live diagnostics showed loaded Relay modules and actual search results. The
  mounted Home snapshot contained 4 allowed posts and 8 filtered posts, with no
  pending or unavailable classifications. Legacy requests still returned HTTP
  400 in some fallback paths; those failures were not cached as denials.

The user was asked to confirm visible ordinary friends in both Home and Stories.
The account-count evidence verifies live lookup recovery; it does not establish
which accounts Instagram chose to place in the current story tray or feed.
