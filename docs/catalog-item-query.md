# Catalog Item Query Contract

`GET /api/catalog/items` is the read-only, Item Identity–centered query boundary for
the complete Catalog Repository. It does not replace `GET /api/catalog` or the
semantic-review object endpoint.

## Search

The server normalizes both the query and indexed values by:

1. trimming leading and trailing whitespace;
2. applying Unicode NFKC normalization;
3. collapsing repeated whitespace to one space; and
4. applying lowercase comparison.

Search covers these fields in priority order:

1. `itemId`
2. `confirmedName`
3. `candidateName`
4. `currentIconIdentifier`
5. `historicalIconIdentifier`
6. `mergeChainId`

Ranking is deterministic. Exact matches rank before prefix matches, which rank
before substring matches. Field priority breaks ties within the same match class,
and Item ID is the final tie-breaker. `matchedFields` lists every server-observed
field that matched; clients display this explanation without deriving matches.

Current icon identifiers come from effective semantic values and non-superseded
Item Icon Evidence whose currency is `current`. Stale, unknown-currency, or
superseded evidence remains searchable as `historicalIconIdentifier`. A historical
match never changes evidence currency or Display Icon Selection.

Search always targets the complete catalog. Combining a non-empty query with
`scope=pending` returns `400 CATALOG_QUERY_INCOMPATIBLE_SCOPE`.

## Filters

The supported query parameters are:

- `status`
- `disposition`
- `reviewAction`
- `iconFreshness`
- `mergeChainId`
- `level`
- `itemType`

Different fields combine with AND. Repeating one field, or supplying a
comma-separated value, combines those values with OR. The value `unknown` matches
nullable values and explicit `unknown` projection states. Valid filters with no
matches return an exact total of `0` and an empty `items` array.

`scope=pending` includes only Item Identity objects with at least one Semantic
Review Reason. Completeness-only gaps are not pending.

## Sorting

Supported sorts are:

- `relevance` — only with a non-empty query, ascending only;
- `display-title`;
- `chain-level`;
- `updated-at`.

All non-relevance sorts accept `direction=asc|desc`. Null values always follow
known values in both directions. Item ID is the final stable tie-breaker.

## Pagination

The default page size is 50; valid sizes are 1–200. The opaque cursor binds the
normalized query, filters, sort, direction, page size, ordering tuple, last Item
ID, and Catalog Query Revision. A changed query returns
`CATALOG_CURSOR_MISMATCH`; a changed revision returns
`CATALOG_QUERY_REVISION_CHANGED`.
