# Expert Search — API Design

Based on `search-feature-planning.md` (3 search journeys, 9 filter types) and the current `er-1.drawio` schema.

---

## 1. Design Principles

- **One search endpoint, many optional params.** Journeys 1 & 2 ("know the person" / "know the category") are both served by the same `/search/experts` endpoint — a name query and a category filter are just different combinations of the same params. No need for separate "name search" vs "filter search" endpoints.
- **GET, not POST**, for the main search. Search results should be a shareable/bookmarkable/cacheable URL (`?category=it&subcategory=backend&location=dhaka`) — this also makes "remove a single filter" (Section 9 of your doc) trivial on the frontend: just delete one query param and re-fetch.
- **Supporting endpoints are separate from the search endpoint.** Category tree, organization autocomplete, qualification list, and language list are all small, cacheable, low-change lookups — they shouldn't be bundled into every search response.
- **The AI journey (Section 10) is a separate future endpoint that feeds *into* this one.** It should output a category + filter set, then hand off to `/search/experts` — never replace it. Don't build it now, but don't design `/search/experts` in a way that would need to change when it arrives.

---

## 2. Endpoint Summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/search/experts` | Main search + filter + rank (Journeys 1 & 2) |
| GET | `/api/v1/search/suggestions` | Typeahead for the search bar |
| GET | `/api/v1/categories/tree` | Full category → subcategory → sub-subcategory tree |
| GET | `/api/v1/organizations` | Organization autocomplete |
| GET | `/api/v1/qualifications` | Qualification list, scoped by category |
| GET | `/api/v1/languages` | Static language list |
| GET | `/api/v1/locations` | Location autocomplete |
| POST | `/api/v1/search/ai-assist` | *(Future)* Problem → recommended category (Journey 3) |

---

## 3. `GET /api/v1/search/experts`

The core endpoint. Every filter from Section 8 of your planning doc maps to a query param here.

### Query Parameters

| Param | Type | Maps to (schema) | Notes |
|---|---|---|---|
| `q` | string | Full-text index across `Profiles.name`, `Experts.bio`, `Categories.name`, `organizations.name` | Free text. Powers "Dr. Luna", "Python developer", "Brainstation Python developers" all with one param — no NLP needed for MVP, just multi-field match |
| `category_id` | int | `Experts.category_id` | Top-level category |
| `subcategory_id` | int | `Categories.id` where `parent_id = category_id` | Since your `Categories` table is self-referencing, subcategory and sub-subcategory are just deeper `category_id` values — you may not need separate param names at all. Simplest: **one param, `category_id`**, always pointing at the most specific node the user picked. The tree endpoint (below) tells the frontend what depth it's at. |
| `location` | string | *(pending schema update — see note below)* | City/area free text for now |
| `country` / `division` / `city` / `area` | string | `Locations.*` (once added) | Structured filtering once the location table exists |
| `remote` | bool | `Experts.is_remote` *(pending)* | |
| `radius_km` + `lat` + `lng` | number | `Locations.lat/lng` *(pending)* | Only usable once locations are geocoded |
| `price_min`, `price_max` | number | `Experts.fee` *(pending: needs min/max + price_type — see prior schema note)* | |
| `price_type` | enum | `Experts` pricing model field *(pending)* | per_consultation / per_hour / per_session / per_project |
| `min_rating` | number (0–5) | `Experts.avg_rating` | e.g. `4.5` |
| `min_reviews` | int | `Experts.review_count` | e.g. `50` |
| `verified` | enum: `all` \| `verified` \| `unverified` | `Experts.verification_status` | Default `all` |
| `organization_id` | int | `expert_organizations.organization_id` | |
| `qualifications[]` | int[] | `expert_qualifications.qualification_id` | Multi-select, **OR** semantics (expert matches if they have *any* selected qualification) |
| `languages[]` | int[] | `expert_languages.language_id` | Multi-select, **OR** semantics |
| `status` | enum | `Experts.availibility_status` | `active` / `inactive` (extendable later to `available_now`, etc.) |
| `sort` | enum | — | `relevance` (default) \| `rating` \| `reviews` \| `newest` \| `price_low` \| `price_high` |
| `page`, `per_page` | int | — | Offset pagination is fine at MVP scale; default `per_page=20` |

All filters are optional and combine with **AND** (a request with `category_id` + `min_rating` + `verified=verified` must satisfy all three). Within a single multi-select filter like `qualifications[]`, values combine with **OR** — worth confirming this matches your intent, since it's the one place the doc's checkbox UI is ambiguous.

### Response

```json
{
  "meta": {
    "total_results": 42,
    "page": 1,
    "per_page": 20,
    "applied_filters": { "category_id": 12, "min_rating": 4.5 }
  },
  "facets": {
    "available_qualifications": [{ "id": 3, "name": "BSc", "count": 18 }],
    "price_range_in_results": { "min": 500, "max": 3000 }
  },
  "data": [
    {
      "expert_id": 501,
      "name": "Dr. Luna Ahmed",
      "photo_url": "...",
      "category": "IT",
      "subcategory": "Backend Developer",
      "specialization": "Python",
      "organization": "Brainstation",
      "location": "Dhaka",
      "is_remote": false,
      "availability_status": "active",
      "avg_rating": 4.8,
      "review_count": 213,
      "verification_status": "verified",
      "fee_summary": "৳500–2000 / consultation"
    }
  ],
  "suggestions": null
}
```

`facets` is optional for MVP but cheap to add if you're already computing aggregate counts — it's what lets the frontend show "BSc (18)" next to a checkbox instead of a blind list, per your Section 9 progressive-filtering UX.

`suggestions` is populated **only when `total_results = 0`**, per Section 9's "Empty Results" behavior:

```json
"suggestions": [
  { "action": "remove_filter", "filter": "verified", "label": "Try removing \"Verified\"" },
  { "action": "lower_filter", "filter": "min_rating", "value": 4.0, "label": "Try lowering the rating to 4.0+" }
]
```
Computing these server-side (re-running the query with one filter dropped at a time and checking which relaxation produces results) is more reliable than hardcoding suggestion text on the frontend.

---

## 4. `GET /api/v1/search/suggest` (Need to be revised)

Powers the search bar's typeahead (Section 7 — "the search bar should support both direct search and discovery"). Called on every keystroke, so keep it fast and cheap — separate from the full search endpoint.

**Params:** `q` (required), `limit` (default 8)

**Response:** a mixed, typed list so the frontend can group results:

```json
{
  "suggestions": [
    { "type": "expert", "id": 501, "label": "Dr. Luna Ahmed", "subtitle": "Cardiologist · Dhaka" },
    { "type": "category", "id": 12, "label": "Backend Developer" },
    { "type": "organization", "id": 8, "label": "Brainstation" }
  ]
}
```

Selecting an `expert` suggestion navigates straight to the profile; selecting a `category` or `organization` suggestion pre-fills that filter and runs `/search/experts`. This is the mechanism, not NLP, that makes "Brainstation" or "Python developer" feel like they "just work" in Section 7's examples — no query parsing required at MVP.

---

## 5. Supporting (lookup) endpoints

| Endpoint | Params | Response | Why separate |
|---|---|---|---|
| `GET /categories/tree` | none (or `parent_id` for lazy-loading one level) | Nested category → subcategory → sub-subcategory tree | Powers Section 3's cascading dropdowns. Since your schema already supports arbitrary depth via `parent_id`, return it as a recursive tree so the frontend doesn't need to know the depth in advance |
| `GET /organizations/search` | `q` | `[{id, name, type}]` | Autocomplete for the organization filter, backed by `organizations.name` |
| `GET /qualifications` | `category_id` (required) | `[{id, name}]` | Scoped per category — a Doctor sees MBBS/MD, a Developer sees BSc/MSc, matching how you scoped `qualifications.category_id` in the schema |
| `GET /languages` | none | `[{id, name}]` | Static/rarely-changing, safe to cache aggressively on the client |
| `GET /locations/search` | `q` | `[{id, city, division, country}]` | Depends on the `Locations` table being built — until then, this can temporarily just be a distinct-values query over free-text `office_address`, with reduced accuracy |

---

## 6. Notes on schema dependencies

Two filters in this design are marked "pending" because the underlying schema isn't there yet (flagged in our earlier ER review):

- **Location filtering** (`country`/`division`/`city`/`area`/`radius`) needs the `Locations` table. Until it exists, `location` can only do a `LIKE`-style match against `Experts.office_address`, which won't reliably support "Dhaka" catching "Dhaka, Bangladesh."
- **Price range filtering** needs `Experts.fee` split into `min_price` / `max_price` / `price_type`, since a single scalar can't represent a range or distinguish per-hour vs per-project.

Both are safe to launch as simplified/best-effort versions and upgrade later — the API contract above (`location`, `price_min`, `price_max`) doesn't need to change when the schema catches up, only the query behind it gets more precise.

---

## 7. Future: `POST /api/v1/search/ai-assist`

Not for MVP. Contract sketch so it doesn't block later:

**Request:** `{ "problem_description": "frequent headaches for a few days" }`
**Response:** `{ "recommended_category_id": 45, "recommended_category": "Neurology", "confidence": 0.82 }`

The frontend takes that response and calls `/search/experts?category_id=45` — this endpoint never returns expert results itself, only a category recommendation, which keeps ranking/filtering logic in one place.
