# Lesson 30 — Search Theory: From "Dr. Luna" to a Ranked Result

> **What you'll get:** the mental model for every line of Lesson 40. Search is where most backends either sink or swim — easy to write a query that returns the right rows, hard to write one that does it at p99 < 200ms for 100k experts.
>
> **No code in this lesson.** Just diagrams, decision points, and the Postgres features we'll lean on.

---

## 1. Goal

After this lesson you can:

1. Decompose any search request into *intent → filters → ranking* and explain each stage.
2. Decide whether `ILIKE`, `pg_trgm`, `tsvector`, or a separate search engine is the right tool for the job.
3. Read an `EXPLAIN ANALYZE` plan and identify a sequential scan that should be an index scan.
4. Justify our scoring function (text match → category → verification → Bayesian-adjusted rating → review count) instead of "sort by rating".
5. Compute facets correctly so the UI can show "BSc (18)" without firing a second query.
6. Generate empty-result suggestions server-side by selectively relaxing filters.

---

## 2. Why this matters — the trap

The naïve search:

```ts
const experts = await this.repo.find({
  where: { /* every filter */ },
  order: { avg_rating: 'DESC' },
});
```

Returns correct rows. Fails at scale for three reasons:

1. **N+1 by default.** Each `expert.category`, `expert.organization`, etc., triggers a lazy query.
2. **No full-text ranking.** `name LIKE '%Luna%'` matches; but `name = 'Luna'` ranked above `name = 'Luna Hospital'` is luck.
3. **Filters in `where: {}` force Postgres to compose them all *before* sorting.** On 100k rows that's a sort over the whole filtered set. Wrong index → seconds.

The fix isn't exotic. It's the *sequence*: build one query, hand it to Postgres with the right index, and rank in a single SQL statement.

---

## 3. Concepts

### 3.1 The three-stage pipeline

```
                 ┌──────────────┐
   User input ──►│   Intent    │  (q, category, location, ...)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │   Filters    │  (WHERE category_id = … AND …)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐
                 │   Ranking    │  (ORDER BY score DESC, …)
                 └──────┬───────┘
                        ▼
                  Experts + facets + suggestions
```

- **Intent:** what does the user want? For our MVP, the *intent* is implicit in the params (`q` → text search; `category_id` → filter; both → both).
- **Filters:** the `WHERE` clause. AND across filters, OR within multi-selects.
- **Ranking:** the `ORDER BY` clause, which uses a computed score expression.

**Why three stages, not one?** Because filtering and ranking have different jobs. Filtering says "who qualifies"; ranking says "in what order". If you conflate them — e.g. by hardcoding `WHERE avg_rating >= 4.5` for "best experts" — you've removed the user's ability to opt out.

### 3.2 The Postgres text-search toolkit

Postgres gives us four tools. Pick the cheapest that meets the requirement.

| Tool          | What it does                                                  | Cost            | Use when                                              |
|---------------|---------------------------------------------------------------|-----------------|-------------------------------------------------------|
| `ILIKE`       | Case-insensitive substring match                              | Full table scan unless prefix-anchored | Simple "starts with" autocompletes (`name LIKE 'Lun%'`) |
| `pg_trgm`     | Trigram index → fuzzy substring matching                      | Index lookup    | Typo tolerance ("Luna" vs "Lna")                      |
| `tsvector`    | Tokenized, stemmed, weighted full-text                        | GIN index lookup| Real word-level search across multiple fields         |
| External (Meilisearch, Elasticsearch) | Pre-built search engine with faceting, fuzzy, ML | Infrastructure cost | Scale, multi-lingual, ML ranking              |

**Our choice:** `tsvector` for the main search (multi-field, multi-word, weighted), `pg_trgm` as a fallback for short queries / typos, `ILIKE` for autocomplete on category/organization names.

**Why not Elasticsearch yet?** It would let us skip ranking tuning, faceting, and partial indexes. But it adds an entire service to operate, and our schema doesn't justify it at MVP scale. Lesson 50 lists the migration path: when `EXPLAIN ANALYZE` shows > 200ms p95, *then* evaluate.

### 3.3 `tsvector` in one paragraph

A `tsvector` is a sorted list of lexemes (normalized tokens) with position info. Postgres provides `to_tsvector('english', 'Dr. Luna Ahmed')` → `'luna':2 'dr.':1 'ahmed':3`. You index this column with GIN, then query with `@@ to_tsquery('english', 'luna')`.

The `ts_rank` function returns a relevance score (0..1-ish, not normalized across queries). You can weight fields: `setweight(to_tsvector(name), 'A') || setweight(to_tsvector(bio), 'B')` puts matches in `name` higher than in `bio`.

For your schema, the searchable fields are:

```ts
setweight(to_tsvector(coalesce(profile.full_name, '')), 'A')
|| setweight(to_tsvector(coalesce(expert.bio, '')), 'B')
|| setweight(to_tsvector(coalesce(category.name, '')), 'C')
|| setweight(to_tsvector(coalesce(organization.name, '')), 'C')
```

(A/B/C/D weights rank as 1.0/0.4/0.2/0.1 by default.)

### 3.4 The scoring function

A score expression like this:

```sql
ts_rank(expert_search_tsv, plainto_tsquery('english', :q))   -- text match
+ CASE WHEN expert.verification_status = 'verified' THEN 0.5 ELSE 0 END
+ CASE WHEN category.id IN (
    WITH RECURSIVE cat AS (
      SELECT id FROM categories WHERE id = :categoryId
      UNION
      SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
    )
    SELECT id FROM cat
  ) THEN 0.3 ELSE 0 END
+ bayesian_rating(expert.avg_rating, expert.review_count, 3.5, 10)
```

**Why Bayesian-adjusted rating?**

A 5.0 from 1 review shouldn't outrank a 4.7 from 200 reviews. The Bayesian average solves this:

```
adjusted = (v / (v + m)) * R + (m / (v + m)) * C

where:
  R = expert's avg_rating
  v = expert's review_count
  m = minimum reviews to trust (we use 10)
  C = global mean rating (we use 3.5)
```

The intuition: until an expert has `m` reviews, lean toward `C`. As reviews grow, lean toward `R`. This shrinks the variance of "lucky one-review wonders".

Lesson 40 implements this as a generated column on `experts` so it's computed once and indexed, not on every query.

### 3.5 Facets — and why they're free if you're careful

Faceted search answers "how many of the current results would match *if* I also filtered by X?". The naïve way:

```sql
SELECT qualification_id, COUNT(*) FROM expert_qualifications
WHERE expert_id IN (...current result ids...)
GROUP BY qualification_id;
```

This requires you to *have* the current result ids, which means you have to *finish* the search first. The smarter way:

```sql
SELECT q.id, q.name, COUNT(*) FROM qualifications q
JOIN expert_qualifications eq ON eq.qualification_id = q.id
WHERE eq.expert_id IN (
  -- the same WHERE clause from the main search, *without* the qualifications filter
)
GROUP BY q.id
ORDER BY 2 DESC;
```

This re-uses the same filter machinery; it's almost free.

### 3.6 Pagination: offset vs. keyset

| Approach  | How                                                                 | When to use                              |
|-----------|---------------------------------------------------------------------|------------------------------------------|
| Offset    | `LIMIT 20 OFFSET 4000`                                              | Admin tools; depth-of-result UI         |
| Keyset    | `WHERE (created_at, id) < (:lastCreatedAt, :lastId) ORDER BY ...`   | Infinite scroll, large result sets      |

For our search we use offset (small page numbers, predictable URLs). Lesson 50 lists the migration to keyset if/when result sets grow.

### 3.7 Empty-result suggestions — server-side relaxation

The UI's "No results" message is better when the server says *which* filter to relax. Algorithm:

```
empty = run query → 0 rows
for each filter f:
    relaxed = run query with f removed
    if relaxed > 0:
        suggest(f)
sort suggestions by impact (more matches first)
return top 3
```

This costs N+1 queries for N filters. Acceptable for empty results (rare path); for non-empty results, you don't compute suggestions.

### 3.8 Caching strategy

Two cache layers:

1. **Per-request result cache (Redis):** key = `sha256(sorted query params)`. TTL 60s. Works because search queries are mostly repeated.
2. **HTTP cache (CDN/Cloudflare):** for *anonymous* search results, `Cache-Control: public, max-age=30`. Stale-while-revalidate for snappy UX.

Authenticated searches don't get cached by CDN (response includes user-specific fields).

### 3.9 Indexes — what to add before launching

For search, the minimum index set:

| Index                                              | Why                                                                    |
|----------------------------------------------------|------------------------------------------------------------------------|
| `experts(category_id, status, avg_rating DESC)`    | Category browse + default sort                                          |
| `experts(verification_status) WHERE status='active'` | Verified-only filter, partial                                          |
| `experts USING GIN (search_tsv)`                   | Full-text search                                                       |
| `experts USING GIN (name gin_trgm_ops)`             | Trigram name search (Lesson 40)                                        |
| `expert_qualifications(qualification_id, expert_id)` | Reverse direction for facet counts                                    |
| `expert_languages(language_id, expert_id)`         | Same                                                                   |
| `expert_organizations(organization_id, expert_id)` | Same                                                                   |
| `expert_prices(price_id, expert_id)`               | Same                                                                   |

Each is justified by either a query path or a facet computation.

### 3.10 The "no SQL injection here, but…" rule

Our DTO uses `class-validator` and TypeORM's `QueryBuilder`. We **never** concatenate user input into SQL. `where('name = :name', { name })` is parameterized. `where('name ILIKE :q', { q: `%${q}%` })` is parameterized **but** the wildcard `%` is added in code, not in user input. If a user types `%`, it's escaped because `LIKE` treats it as a literal only if `ESCAPE` is set; Lesson 40 sets `ESCAPE` defensively.

---

## 4. Decision points

| Decision                                                | My choice                                                  | Push back if…                                              |
|---------------------------------------------------------|------------------------------------------------------------|------------------------------------------------------------|
| Full-text engine                                        | `tsvector` + GIN                                           | You have > 500k experts and need typo tolerance + facets    |
| Typo tolerance                                          | `pg_trgm` fallback when `tsvector` returns 0 rows          | Your users don't make typos (unlikely)                      |
| Score weights                                           | A=name, B=bio, C=category, C=org                           | You want orgs to rank higher than category (unusual)        |
| Bayesian prior (m, C)                                   | m=10, C=3.5                                                | Your domain has different review norms                       |
| Default sort                                            | `score DESC, review_count DESC`                            | UI explicitly requests sort=rating/reviews/newest/price      |
| Pagination                                              | Offset, `per_page=20`                                      | You'll have > 100k experts and infinite scroll              |
| Facet count thresholds                                  | Hide facets with < 1 result                                | You want to show all (UI choice)                            |
| Empty-result suggestions                                | Up to 3, server-computed                                   | You want client-side suggestions                            |
| Anonymous caching                                       | 30s CDN cache                                              | All results are user-personalized (then no caching)         |
| Free-text multi-word `q`                                | `plainto_tsquery`                                          | You want phrase support (`phraseto_tsquery`)                |
| Search across sub-categories                            | Recursive CTE on `categories` to expand                    | Sub-categories are flat                                    |

---

## 5. Worked example — the SQL we will write in Lesson 40

Given this query:

```
GET /api/v1/search/experts?q=python&category_id=12&min_rating=4.5&languages[]=1&languages[]=2&verified=verified
```

The SQL we build (roughly):

```sql
WITH RECURSIVE cat_tree AS (
  SELECT id FROM categories WHERE id = $1
  UNION
  SELECT c.id FROM categories c JOIN cat_tree t ON c.parent_id = t.id
),
qualifying_experts AS (
  SELECT e.*
  FROM experts e
  WHERE e.status = 'active'
    AND ($1::int IS NULL OR e.category_id IN (SELECT id FROM cat_tree))
    AND ($2::int IS NULL OR e.avg_rating >= $2)
    AND e.verification_status = 'verified' -- $3 verified filter
    AND (
      $4::text IS NULL OR e.search_tsv @@ plainto_tsquery('english', $4)
    )
  ORDER BY (
        ts_rank(e.search_tsv, plainto_tsquery('english', $4))
        + CASE WHEN e.verification_status = 'verified' THEN 0.5 ELSE 0 END
        + e.bayesian_rating
      ) DESC,
      e.review_count DESC
  OFFSET $5 LIMIT $6
)
SELECT
  e.*, u.email, p.full_name, c.name AS category_name
FROM qualifying_experts e
JOIN users u ON u.id = e.user_id
JOIN profiles p ON p.user_id = u.id
JOIN categories c ON c.id = e.category_id;
```

**Plus parallel queries for facets and suggestions.** Three queries total per search; the heavy work is in the CTE + indexed scan.

---

## 6. Self-check before Lesson 40

1. Why is "highest rating first" the wrong default sort? What does Bayesian adjustment fix?
2. `ILIKE '%Luna%'` vs `tsvector @@ to_tsquery('luna')` — which is faster at 100k rows? Why?
3. Why do we use `setweight` in the `tsvector`? What goes wrong if you don't?
4. When is offset pagination bad? When is it fine?
5. What is a partial index, and why does `WHERE status='active'` matter for it?
6. How would you implement empty-result suggestions? (Write the algorithm in 5 lines.)
7. What's the difference between filtering and ranking? Give an example where conflating them produces a bad UX.
8. Why is `pg_trgm` not the primary search index?
9. Why does the `setweight(to_tsvector(profile.full_name), 'A')` come before `setweight(to_tsvector(expert.bio), 'B')`? What if you swapped them?
10. What two things make facets expensive if you do them naively, and how does the Lesson 30 approach avoid them?

When all ten have answers, go to **Lesson 40** — we build the endpoints.