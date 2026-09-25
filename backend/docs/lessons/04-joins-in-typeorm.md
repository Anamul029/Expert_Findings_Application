# Lesson 04 — Joins in TypeORM: From Decorators to SQL

> **What you'll get:** three ways to fetch related data (`relations`, `leftJoinAndSelect`, raw `QueryBuilder`), the trade-offs of each, the SQL they actually emit, and the patterns for the queries in `er-2.drawio` and `search-feature-planning.md`. By the end, you should be able to read any service method and predict the SQL it sends.
>
> **Why this lesson exists:** TypeORM lets you write "find by id with relations" four ways, and only one of them is the right default. The wrong choice is invisible on a 10-row dev DB and catastrophic on a 100k-row prod DB. This lesson makes the choice explicit and ties it to the SQL you'll see in `EXPLAIN ANALYZE`.
>
> **Prerequisites:** Lessons 02 and 03. You must be fluent with the three cardinalities, the `onDelete` matrix, and FK indexing.

---

## 1. Goal

By the end of this lesson you can:

1. Pick `relations` vs `leftJoinAndSelect` vs raw `QueryBuilder` for any read pattern, and justify the choice in one sentence.
2. Read a service method and predict the SQL it emits (number of queries, `JOIN`s, indexes used).
3. Detect the N+1 pattern in a loop and replace it with a single `*AndSelect`.
4. Write the four "headline" queries of the search feature: profile + category tree, qualified-and-rated experts, expert + their full submission, category with full subtree.
5. Promote a pivot to an entity when business data arrives, and rewrite the affected joins.
6. Recognize and fix the seven most common runtime bugs that come from relationship loading.

---

## 2. Why this matters — the three failure modes

Failure mode 1: **the N+1**. You load 50 categories and then loop `category.qualifications.length`. Each iteration fires a query. Total: 51 queries. Slow pages, slow APIs, angry users. The fix is one `leftJoinAndSelect`.

Failure mode 2: **the silent `undefined`**. You load an expert and access `expert.category.name`. It works in dev (you loaded the category). It crashes in prod (a different code path doesn't). The fix is to make the relationship either eager, explicitly loaded in the service, or marked optional in the DTO.

Failure mode 3: **the wrong join type**. You write `innerJoinAndSelect` instead of `leftJoinAndSelect`. Your "show me experts with their optional languages" query drops experts who don't speak any tracked language. The fix is to know what each join type means in SQL.

This lesson is the rubric for all three.

---

## 3. The three loading styles

### 3.1 `relations` — the simple option

```ts
const category = await this.repo.findOne({
  where: { id: 1 },
  relations: { qualifications: true, experts: true },
});
```

**SQL emitted** (approximately):

```sql
SELECT * FROM categories WHERE id = $1;
SELECT * FROM qualifications WHERE category_id = $1;
SELECT * FROM experts WHERE category_id = $1;
```

**Three queries**. Always. Even when one would do.

**When to use:**

- Quick admin pages.
- One-shot scripts.
- Code where the depth is small and the count is small.

**When NOT to use:**

- Lists with N>20 parents and N>1 children per parent.
- Deep graphs (parent → child → grandchild).
- Anywhere you might forget a relation and ship `undefined`.

### 3.2 `leftJoinAndSelect` / `innerJoinAndSelect` — the workhorse

```ts
const category = await this.repo
  .createQueryBuilder('c')
  .leftJoinAndSelect('c.qualifications', 'q')
  .leftJoinAndSelect('c.experts', 'e')
  .leftJoinAndSelect('e.user', 'u')
  .where('c.id = :id', { id: 1 })
  .getOne();
```

**SQL emitted** (approximately):

```sql
SELECT c.*, q.*, e.*, u.*
FROM categories c
LEFT JOIN qualifications q ON q.category_id = c.id
LEFT JOIN experts e        ON e.category_id = c.id
LEFT JOIN users u          ON u.id = e.user_id
WHERE c.id = $1;
```

**One query**. Real SQL `JOIN`. Indexable, plan-able, predictable.

**`LEFT JOIN` vs `INNER JOIN`:**

- `LEFT JOIN` keeps parents without children (a category with no qualifications). Use this by default for collections you want to render even when empty.
- `INNER JOIN` drops parents without matching children. Use this only when you specifically want to filter ("categories that have at least one qualification").

**When to use:** anything you ship to production. This is the default for services.

### 3.3 `QueryBuilder` join without selecting — the filter-only option

```ts
const expertIds = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'q', 'q.id IN (:...ids)', { ids: [1, 2, 3] })
  .select('e.id')
  .getMany();
```

**SQL emitted** (approximately):

```sql
SELECT e.id
FROM experts e
INNER JOIN expert_qualifications eq ON eq.expert_id = e.id
INNER JOIN qualifications q        ON q.id = eq.qualification_id
WHERE q.id IN ($1, $2, $3);
```

**No `SELECT *` on the joined tables.** You only get the columns you explicitly `.select()`. Cheaper than `*AndSelect` when you don't need the joined data.

**When to use:** the search feature's "filter by joined rows" cases (filter by language, filter by qualification, filter by price tier). You want the FK lookup but not the joined rows in the response.

### 3.4 The decision matrix

| Loading style        | SQL queries | Use case                                            |
|----------------------|-------------|-----------------------------------------------------|
| `relations`          | 1 + N (per relation) | Admin pages, one-shots, dev scripts       |
| `*AndSelect`         | 1 (with JOINs) | Default for services — list views, detail views     |
| `QueryBuilder` filter | 1 (no join columns) | "Filter by related" without including the related   |
| `QueryBuilder` with explicit columns | 1 (only selected columns) | Aggregations, projections, computed scores |

---

## 4. The N+1 pattern

### 4.1 What it looks like

```ts
const categories = await this.repo.find();
for (const c of categories) {
  console.log(c.qualifications.length);   // ← fires SELECT on every iteration
}
```

If you have 50 categories, that's 51 queries. With 1000 categories, the loop runs for seconds.

### 4.2 How to detect it

Run your dev server with `logging: 'all'` (or with a query logger). Watch the SQL stream. If you see `SELECT * FROM qualifications WHERE category_id = $1` repeating with different `$1` values, you have an N+1.

You can also detect it programmatically: log a counter inside a query listener, and assert in tests "the endpoint with 50 rows should fire ≤ 5 queries".

### 4.3 How to fix it

**Option A: `relations` (easy but limited).**

```ts
const categories = await this.repo.find({ relations: { qualifications: true } });
for (const c of categories) {
  console.log(c.qualifications.length);   // ← already loaded
}
```

Two queries (one for categories, one for qualifications). Fine for 50 parents.

**Option B: `leftJoinAndSelect` (one query, the right default).**

```ts
const categories = await this.repo
  .createQueryBuilder('c')
  .leftJoinAndSelect('c.qualifications', 'q')
  .getMany();
for (const c of categories) {
  console.log(c.qualifications.length);
}
```

One query. Scales to 10k categories.

**Option C: select what you need.**

```ts
const rows = await this.repo
  .createQueryBuilder('c')
  .leftJoin('c.qualifications', 'q')
  .select('c.id', 'category_id')
  .addSelect('COUNT(q.id)', 'qual_count')
  .groupBy('c.id')
  .getRawMany();
```

One query, aggregates returned directly. Cheaper if you only need the count.

### 4.4 The hidden N+1 — lazy properties

Inverse-side properties (`category.experts`, `post.comments`) are lazy by default. Accessing them fires a query — even if you didn't write a loop.

```ts
const category = await this.repo.findOne({ where: { id: 1 } });
console.log(category.experts);          // ← SELECT * FROM experts WHERE category_id = 1
```

The fix is the same as above: load it explicitly. Don't let lazy access creep into production code without an `EXPLAIN` showing you the query cost.

---

## 5. Worked examples — the queries you will actually write

### 5.1 "Show me an expert's profile + their primary category + the category's parent"

The "expert profile detail" page. Loads `Expert → User (profile) → Category → Category.parent`.

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .leftJoinAndSelect('c.parent', 'cp')               // ← the tree
  .leftJoinAndSelect('e.qualifications', 'q')
  .leftJoinAndSelect('e.organizations', 'o')
  .leftJoinAndSelect('e.languages', 'l')
  .where('e.id = :id', { id: 42 })
  .getOne();
```

**SQL (approximately):**

```sql
SELECT e.*, u.*, c.*, cp.*, q.*, o.*, l.*
FROM experts e
LEFT JOIN users u          ON u.id = e.user_id
LEFT JOIN categories c     ON c.id = e.category_id
LEFT JOIN categories cp    ON cp.id = c.parent_id
LEFT JOIN expert_qualifications eq ON eq.expert_id = e.id
LEFT JOIN qualifications q         ON q.id = eq.qualification_id
LEFT JOIN expert_organizations eo  ON eo.expert_id = e.id
LEFT JOIN organizations o          ON o.id = eo.organization_id
LEFT JOIN expert_languages el      ON el.expert_id = e.id
LEFT JOIN languages l              ON l.id = el.language_id
WHERE e.id = 42;
```

**Indexes used:** `experts(id)` (PK), `users(id)`, `categories(id)`, `expert_qualifications(expert_id)` (composite PK prefix), `qualifications(id)`, etc. If you see a sequential scan on any of these, add the index from Lesson 03 §6.2.

**Gotcha:** this query can return a row per (expert × qualification × organization × language). That's *expected* — TypeORM de-duplicates back into nested arrays. The duplication is in the SQL, not the response. To reduce duplication, see §5.6.

### 5.2 "All verified experts who speak Bangla AND English, ordered by rating"

The headline query from `search-feature-planning.md` Journey 2.

```ts
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.languages', 'l1', 'l1.name = :l1', { l1: 'Bangla' })
  .innerJoin('e.languages', 'l2', 'l2.name = :l2', { l2: 'English' })
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .where('e.verification_status = :s', { s: 'verified' })
  .orderBy('e.avg_rating', 'DESC')
  .addOrderBy('e.review_count', 'DESC')
  .limit(50)
  .getMany();
```

**SQL (approximately):**

```sql
SELECT DISTINCT e.*, u.*, c.*
FROM experts e
INNER JOIN expert_languages el1 ON el1.expert_id = e.id
INNER JOIN languages l1         ON l1.id = el1.language_id AND l1.name = 'Bangla'
INNER JOIN expert_languages el2 ON el2.expert_id = e.id
INNER JOIN languages l2         ON l2.id = el2.language_id AND l2.name = 'English'
LEFT JOIN users u          ON u.id = e.user_id
LEFT JOIN categories c     ON c.id = e.category_id
WHERE e.verification_status = 'verified'
ORDER BY e.avg_rating DESC, e.review_count DESC
LIMIT 50;
```

**Two joins on the same pivot** is the M:N pattern for "AND across a multi-select". Each `innerJoin` adds a row to the WHERE clause. The `DISTINCT` is implicit because TypeORM deduplicates the join rows into the response.

### 5.3 "Promote `expert_qualifications` to a real entity (because we now need `obtained_year`)"

The pivot promotion from Lesson 03 §7. After promotion, the relationship is two 1:Ns instead of one M:N. The query changes shape:

**Before:**

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'q')   // @ManyToMany via @JoinTable
  .where('e.id = :id', { id: 42 })
  .getOne();
```

**After:**

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'eq')              // @OneToMany → ExpertQualification
  .leftJoinAndSelect('eq.qualification', 'q')                // @ManyToOne → Qualification
  .where('e.id = :id', { id: 42 })
  .getOne();

// And now you can filter on obtainedYear:
const expertWithRecentDegrees = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'eq')
  .leftJoinAndSelect('eq.qualification', 'q')
  .where('eq.obtainedYear >= :y', { y: 2010 })
  .getMany();
```

The second query was *impossible* on the implicit pivot. That's the entire argument for promoting early.

### 5.4 "An expert's full submission, including documents and verifications"

The verification admin queue. Deep join.

```ts
const submission = await this.submissionRepo
  .createQueryBuilder('s')
  .leftJoinAndSelect('s.expert', 'e')
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('s.documents', 'd')
  .leftJoinAndSelect('s.verifications', 'v')
  .leftJoinAndSelect('e.qualifications', 'q')
  .where('s.id = :id', { id: 42 })
  .getOne();
```

**Watch the cartesian explosion.** Every `documents` row and every `verifications` row multiplies the result set. For one submission with 5 documents and 3 verifications, you get 15 rows in SQL that TypeORM de-duplicates back into nested arrays. For a list endpoint, see §5.6.

### 5.5 "Category with full subtree"

Use a recursive CTE. Postgres handles it natively:

```ts
async findSubtree(rootId: number): Promise<Category[]> {
  const rows = await this.repo.manager.query(
    `
    WITH RECURSIVE category_tree AS (
      SELECT id, parent_id, name, 0 AS depth
      FROM categories
      WHERE id = $1

      UNION ALL

      SELECT c.id, c.parent_id, c.name, ct.depth + 1
      FROM categories c
      JOIN category_tree ct ON c.parent_id = ct.id
    )
    SELECT * FROM category_tree ORDER BY depth, name;
    `,
    [rootId],
  );

  // Map raw rows back to entities if needed; or return as DTOs.
  return rows;
}
```

The CTE walks the tree in one query. With an index on `categories.parent_id`, it's fast on trees with thousands of nodes.

### 5.6 Avoiding cartesian blowup in lists

The `findOne` queries above are fine because the row count is small. For *list* endpoints, joining 5 collections explodes the result set.

```ts
// DON'T: list endpoint with full graph
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.qualifications', 'q')
  .leftJoinAndSelect('e.languages', 'l')
  .leftJoinAndSelect('e.organizations', 'o')
  .leftJoinAndSelect('e.prices', 'p')
  .getMany();
```

If each expert has 3 qualifications, 2 languages, 1 organization, 2 prices, the SQL returns 3×2×1×2 = 12 rows per expert. 50 experts → 600 SQL rows that TypeORM de-duplicates. It works, but it's wasteful and the network serialization is large.

**Better: paginate the list, then load relations per row.**

```ts
// Step 1: paginated list with minimal data
const page = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.user', 'u')            // user is small (1:1)
  .leftJoinAndSelect('e.category', 'c')        // category is small (N:1)
  .orderBy('e.avg_rating', 'DESC')
  .limit(20)
  .offset(0)
  .getMany();

// Step 2: load the related collections in two queries (or one IN query)
const expertIds = page.map(e => e.id);
const quals = await this.qualRepo
  .createQueryBuilder('q')
  .innerJoin('expert_qualifications', 'eq', 'eq.qualification_id = q.id')
  .where('eq.expert_id IN (:...ids)', { ids: expertIds })
  .getMany();
// Map back into the response server-side.
```

This is what every well-built listing API does. The list endpoint is cheap (no cartesian); the detail endpoint is rich (full graph).

---

## 6. Eager loading — and why to avoid it

You can mark a relation `eager: true` and TypeORM will always load it. This is convenient for prototyping and terrible for production:

- You can't opt out at the call site.
- A "small" eager relation on a list endpoint becomes an N+1 or a cartesian.
- Refactoring away from `eager` requires touching every call site.

The rule: **never use `eager: true` in production code**. Load explicitly per service method. The one legitimate use is for truly always-needed relations on a single entity (e.g. `User.profile` if every request needs the profile).

---

## 7. Transactions and locking

When you write to related entities, the relationship matters:

```ts
// BAD: two writes, two queries, no transaction
const expert = await this.expertRepo.findOne({ where: { id } });
expert.bio = newBio;
await this.expertRepo.save(expert);

// GOOD: one transaction, both writes atomic
await this.dataSource.transaction(async (manager) => {
  const expert = await manager.findOne(Expert, { where: { id } });
  expert.bio = newBio;
  await manager.save(expert);
  // If you also touch related entities here, they go in the same TX.
});
```

For pessimistic locking (e.g. "two admins can't both verify the same submission"):

```ts
await this.repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
```

Don't reach for locks unless you have a measured race condition. Default to transactions + optimistic locking via a `version` column.

---

## 8. Querying through a promoted pivot

After promoting `expert_qualifications` to an entity (Lesson 03 §7), the joins change. The pattern:

```ts
// "All experts with a qualification obtained after 2010, ordered by rating"
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'eq')                   // e.qualifications is now @OneToMany(ExpertQualification)
  .innerJoin('eq.qualification', 'q')                    // eq.qualification is @ManyToOne(Qualification)
  .leftJoinAndSelect('e.user', 'u')
  .where('eq.obtainedYear >= :y', { y: 2010 })
  .andWhere('e.verification_status = :s', { s: 'verified' })
  .orderBy('e.avg_rating', 'DESC')
  .getMany();
```

The two-step join (`eq.qualification`) is the entire reason for promotion. On the implicit pivot, you couldn't filter on `obtainedYear` at all.

---

## 9. Pagination

For list endpoints, always paginate. The default in your codebase:

```ts
const [rows, total] = await this.expertRepo.findAndCount({
  where: { verification_status: 'verified' },
  relations: { user: true, category: true },
  order: { avg_rating: 'DESC', id: 'ASC' },          // tie-breaker for stable pagination
  take: 20,
  skip: 0,
});
```

Rules:

- Always include a tie-breaker in `ORDER BY` (`id ASC` is the cheapest) for stable pagination. Without it, rows can shift between pages.
- Always return `total` (or a `hasMore` boolean) so the UI can render pagination correctly.
- For deep pagination, switch to keyset pagination (`WHERE id > $lastSeenId`) — `OFFSET` gets slow at high page numbers.

---

## 10. Common runtime bugs and how to spot them

| Symptom                                                       | Likely cause                                                            | Fix                                                  |
|---------------------------------------------------------------|-------------------------------------------------------------------------|------------------------------------------------------|
| `expert.category` is `undefined` after `findOne`              | Lazy; you didn't `relations: ['category']` or `leftJoinAndSelect`       | Add the relation, or load it explicitly              |
| `category.qualifications` is `[]` for a real parent           | Inverse-side callback has the wrong property name                       | Match the property name in both decorator callbacks  |
| `QueryFailedError: duplicate key value violates unique constraint` | Missing `unique: true` on a 1:1 FK                                  | Add `unique: true` to `@JoinColumn`                  |
| Slow list page with 100 rows                                  | N+1 — loop loads related entity                                         | Replace loop with `*AndSelect` or `relations`        |
| Deleting a category deletes experts                            | `onDelete: 'CASCADE'` on `experts.category_id`                          | Switch to `RESTRICT`; add explicit move-then-delete  |
| Pivot has duplicate `(a, b)` rows                             | Missing composite PK on `@JoinTable`                                    | Add composite PK in a migration                      |
| `Cannot read property 'experts' of undefined` after service call | DTO didn't include the relation                                      | Move the relation to the response DTO                |
| List endpoint times out at 1000 rows                          | Cartesian blowup from `*AndSelect` on multiple collections              | Paginate + load relations per row                    |
| Two `findOne` calls in a row return different shapes           | One had `relations`, the other didn't                                   | Standardize the service method to always load X      |
| `eager: true` explosion                                       | Marked something eager that's expensive                                 | Remove `eager`, load explicitly                      |
| Search for "experts with no language" returns all experts     | Used `leftJoin` with no `WHERE l.id IS NULL` filter                     | Add `andWhere('l.id IS NULL')`                       |
| `getMany()` returns duplicates                                | Joining the same relation twice via different aliases (e.g. `l1`, `l2`) | Use `DISTINCT` or `select` only the FK               |
| Slow query with `LEFT JOIN`                                   | Missing index on the joined FK                                          | Add the index from Lesson 03 §6.2                     |

---

## 11. The full TypeORM → SQL translation table

For the patterns you'll use most:

| TypeORM code                                                  | SQL it emits                                                          | Queries |
|--------------------------------------------------------------|-----------------------------------------------------------------------|---------|
| `findOne({ where: { id } })`                                 | `SELECT * FROM x WHERE id = $1`                                       | 1       |
| `find({ relations: ['a'] })`                                 | `SELECT * FROM x; SELECT * FROM a WHERE x_id IN (...)`                | 2       |
| `qb.leftJoinAndSelect('x.a', 'a')`                           | `SELECT x.*, a.* FROM x LEFT JOIN a ON a.x_id = x.id`                 | 1       |
| `qb.innerJoin('x.a', 'a').select('x.id')`                    | `SELECT x.id FROM x INNER JOIN a ON a.x_id = x.id`                    | 1       |
| `qb.leftJoinAndSelect(...).leftJoinAndSelect(...)`           | Single SQL with chained LEFT JOINs                                    | 1       |
| `qb.innerJoin('x.a', 'a1', 'cond').innerJoin('x.a', 'a2', ...)` | Single SQL with two aliases on the same join                       | 1       |
| Recursive CTE via `manager.query(...)`                       | The raw SQL you wrote                                                  | 1       |

If you can read this table cold, you can predict the cost of any service method before you run it.

---

## 12. Migration recipe — when you change a relationship

When you change a relationship (add a relation, change `onDelete`, promote a pivot), your migration must:

1. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...(...)` (or `DROP CONSTRAINT`).
2. Set `ON DELETE ...` explicitly — never rely on default.
3. Add the index (`CREATE INDEX ... ON ... (fk_column)`) or drop it.
4. For pivots: add composite PK (or drop and recreate when promoting).
5. Write a `down` migration that reverses every step in opposite order. **Always.**
6. Run the migration against a seeded dev DB. Hand-fire the cascade to confirm it does what you expect.
7. `EXPLAIN ANALYZE` every query that touches the changed column. Compare to before.

Lesson 50 (production readiness) covers the deploy pipeline that catches missing `down` migrations and missing indexes automatically.

---

## 13. The "before you ship" checklist

For every read-heavy service method, before you commit:

- [ ] Did I `leftJoinAndSelect` (or `innerJoin`) for every relation the response DTO needs?
- [ ] Did I avoid `relations` for lists with N>20?
- [ ] Did I avoid `*AndSelect` with 3+ collections on lists?
- [ ] Did I add `take`/`skip` (or keyset pagination)?
- [ ] Did I `EXPLAIN ANALYZE` the emitted SQL?
- [ ] Are there any missing FK indexes from Lesson 03 §6.2?

If you can't tick all six, the method isn't ready.

---

## 14. Self-check

Answer these in writing before moving to Lesson 05.

1. What's the difference between `relations: ['a']` and `leftJoinAndSelect('x.a', 'a')`? How many SQL queries does each emit?
2. Write the query for "all verified experts in the Cardiology category, ordered by review count DESC, with their user loaded".
3. Write the query for "all experts who speak both Bangla and English, with their user loaded, but do not include the language rows in the response".
4. Why is `innerJoin` wrong for fetching "experts + their (possibly empty) languages"?
5. Why is `eager: true` a bad default in production code?
6. What's the N+1 pattern? Write a fix using `leftJoinAndSelect`.
7. You have `findOne({ where: { id }, relations: ['category'] })` and then `category.experts` is `undefined`. Why? Fix it.
8. You want to filter experts by `qualification.obtainedYear >= 2010`, but you used `@JoinTable`. What do you have to do first?
9. Why does `findAndCount({ order: { avg_rating: 'DESC' } })` produce unstable pagination? What's the fix?
10. Your list endpoint joins `experts → qualifications → languages → organizations` and the response is huge. Two strategies to fix it.

When you can answer all ten without re-opening this file, go to **Lesson 05**.
