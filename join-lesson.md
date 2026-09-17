# Join Relationships — A Senior Developer's Tutorial

> Built from reading `er-2.drawio` end-to-end and cross-referencing the live entities under `backend/src/`. Read this top-to-bottom once, then keep it open while you write code.

---

## 0. The Big Picture (what `er-2.drawio` actually says)

`er-2.drawio` is the **second iteration** of your Expert-Findings schema. It is denser than `er-1.drawio`: 12 tables, a self-referencing tree, a one-to-one profile extension, several one-to-many "feed" tables, four many-to-many (M:N) pivot tables, and an `OTP` table that hangs off `Users`. Read the diagram **slowly**, label by label:

| Table            | Purpose                                                              | Cardinalities (FKs it owns / is owned by)                                                                                       |
|------------------|----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `Users`          | Auth + identity                                                      | 1→N: `Posts`, `Reacts`, `Comments`, `Channels`, `Reviews`, `OTP`, `Profiles` (1:1), `Experts` (1:0..1)                          |
| `Profiles`       | Public-facing name/phone/address/photo                               | 1:1 with `Users` (user_id unique) + 1:0..1 with `Experts` (`expert_id` FK)                                                     |
| `Experts`        | The "expert" extension: bio, rating, verification, category, etc.    | N:1 → `Users`, N:1 → `Categories`; 1→N: `Submissions`, `Reviews`; M:N via 4 pivots                                             |
| `Categories`     | Self-referencing tree (`parent_id`)                                  | 1:N self; 1:N → `Experts`, `Qualifications`, `Prices`                                                                          |
| `Qualifications` | Lookup table for credentials                                         | N:1 → `Categories`; M:N with `Experts` via `expert_qualifications`                                                             |
| `Prices`         | Lookup table for fee tiers per category                              | N:1 → `Categories`; M:N with `Experts` via `expert_prices`                                                                     |
| `Organizations`  | Companies / hospitals an expert is affiliated with                   | M:N with `Experts` via `expert_organizations`                                                                                  |
| `Languages`      | Lookup for spoken languages                                          | M:N with `Experts` via `expert_languages`                                                                                      |
| `Posts`          | Feed posts                                                           | N:1 → `Users`; 1:N → `Reacts`, `Comments`                                                                                      |
| `Reacts`         | Likes/reactions on posts                                              | N:1 → `Posts`, N:1 → `Users`                                                                                                   |
| `Comments`       | Comments on posts                                                    | N:1 → `Posts`, N:1 → `Users`                                                                                                   |
| `Channels`       | User-owned groups/pages                                              | N:1 → `Users`                                                                                                                  |
| `Reviews`        | User→Expert rating                                                   | N:1 → `Users`, N:1 → `Experts`                                                                                                 |
| `Submissions`    | An expert's verification package                                     | N:1 → `Experts`; 1:N → `Documents`, `Verifications`                                                                            |
| `Verifications`  | Required verification rules attached to a submission                 | N:1 → `Submissions`                                                                                                            |
| `Documents`      | Files uploaded for a submission                                      | N:1 → `Submissions`                                                                                                            |
| `OTP`            | One-time passwords for verify / reset                                | N:1 → `Users`                                                                                                                  |

> **Reading rule for drawio:** the text labels `1` and `N` near each edge mean **cardinality**, not direction. A line `Users 1—N Posts` means "one user has many posts". The arrow head is decoration; the FK column is the source of truth.

---

## 1. The Three Cardinalities (the only ones that exist)

Every relationship in your schema is one of these. Learn to recognize them on sight:

### 1.1 One-to-One (`1:1`)

**Where in your schema:** `Users` ↔ `Profiles`.

**Meaning:** Each user has at most one profile, and each profile belongs to exactly one user.

**TypeORM pattern (you already use the *inverse side* on `User`):**

```ts
// user.entity.ts
@OneToOne(() => Profile, (profile) => profile.user)
profile?: Profile;
```

```ts
// profile.entity.ts
@OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id' })
user!: User;
```

**Important rules:**

- The owning side is the table that **holds the FK column**. In drawio, `Profiles.user_id` is the FK, so `Profiles` owns the relation.
- The other side (`User.profile`) is the inverse — no `@JoinColumn` there.
- Use `@JoinColumn({ name: 'user_id', unique: true })`. The `unique: true` is what enforces `1:1` at the DB level. If you forget it, you can get a duplicate `profile` row for the same user.

**Benefit of `1:1`:** clean separation of concerns — auth fields stay on `Users`, PII fields stay on `Profiles`. You can also `select: false` sensitive columns (`pass_hash` already does this) without affecting the profile fetch.

**Cons / gotchas:**

- Easy to accidentally create a `0..1:1` (nullable FK) when you meant `1:1`. Decide upfront: should a user exist *without* a profile? If yes → FK nullable. If no → FK `NOT NULL`.
- Cascade deletes can be surprising. `onDelete: 'CASCADE'` on `Profiles.user` means *deleting a user deletes their profile*. That is usually what you want, but document it.

---

### 1.2 One-to-Many / Many-to-One (`1:N`)

This is the **workhorse** of your schema — you have a *lot* of it: `Users→Posts`, `Users→Channels`, `Users→Reviews`, `Experts→Submissions→Documents`, `Categories→Experts`, `Categories→Qualifications`, `Categories→Prices`, `Posts→Reacts`, `Posts→Comments`.

**TypeORM pattern (already used in your codebase — see `categories.entity.ts`):**

```ts
// one side ("parent")
@OneToMany(() => Expert, (expert) => expert.category)
experts!: Expert[];

// many side ("child") — owns the FK
@ManyToOne(() => Category, (category) => category.experts, {
  onDelete: 'RESTRICT', // ← see §5 for which to pick
  nullable: false,      // ← every expert MUST have a category
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

**Benefits:**

- Simple, intuitive, matches SQL thinking 1:1.
- Indexed automatically when you set `@Index()` on the FK column — and you almost always should.
- Eager loading is opt-in (good).

**Cons / gotchas:**

- **Two entities, two decorators, one relationship.** TypeORM needs both `@OneToMany` *and* `@ManyToOne` declared (or only `@ManyToOne` if you never traverse upward). If you declare one without the other, you get nulls at runtime with no error.
- **Lazy loading footgun:** by default, `experts` on a Category is `undefined` until you `await category.experts`. Beginners forget this and ship `.experts.length === 0` bugs. Use `relations: ['experts']` in the find options, or the `leftJoinAndSelect` API.
- **Hidden N+1:** if you load 100 experts and then loop `expert.category.name`, you fire 100 queries. See §4.

---

### 1.3 Many-to-Many (`M:N`)

**Where in your schema:** four pivots — `expert_qualifications`, `expert_organizations`, `expert_languages`, `expert_prices`.

**Why a pivot table instead of a JSON column?** Because you need to *query* "all experts with qualification X" or "all experts who speak Bangla + English". That is impossible without indexed rows.

**TypeORM pattern (the modern, recommended way):**

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts, { cascade: true })
@JoinTable({
  name: 'expert_qualifications',         // match drawio exactly
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

```ts
// qualification.entity.ts (already exists in your code)
@ManyToOne(() => Category, (category) => category.qualifications, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'category_id' })
category!: Category;

// add this so the inverse side is wired
@ManyToMany(() => Expert, (e) => e.qualifications)
experts!: Expert[];
```

**Benefits:**

- Adding/Removing an association is one row insert/delete in the pivot — atomic, fast, indexable.
- Schema-level integrity: you cannot have an `expert_qualifications` row pointing to a non-existent expert (FK).
- Search features in `search-feature-planning.md` (filter by language, qualification, price tier) become straightforward indexed joins.

**Cons / gotchas:**

- **Always have a composite PK** on the pivot (`PRIMARY KEY (expert_id, qualification_id)`). Without it, you can insert duplicate `(expert, qualification)` rows and waste space.
- **Do not put business data on the pivot** (timestamps, "is_verified" flags, etc.) using the implicit TypeORM `@JoinTable` form. The moment you need a column, **promote the pivot to a real entity** with its own `@Entity()` and use two `1:N`s instead. (You'll need this for `expert_qualifications` once you want `obtained_year` or `verified_at`.)
- **`onDelete` is invisible to TypeORM on M:N.** TypeORM does not know which side should cascade — you must write the FK `ON DELETE` rules explicitly in a migration.
- **Avoid `@JoinTable` on *both* sides.** Pick one. If both sides declare it, TypeORM silently creates the wrong number of columns.

---

## 2. The Two Special-Case Relationships

### 2.1 Self-referencing tree — `Categories.parent_id`

This is a **`1:N` from a table to itself**. Same TypeORM pattern, just typed to the same entity:

```ts
// categories.entity.ts (already there)
@ManyToOne(() => Category, (category) => category.children, {
  onDelete: 'CASCADE',
  nullable: true,
})
@JoinColumn({ name: 'parent_id' })
parent!: Category;

@OneToMany(() => Category, (category) => category.parent)
children!: Category[];
```

**Benefits:** unlimited depth, simple, recursive CTEs work natively in Postgres (`WITH RECURSIVE`).

**Cons / gotchas:**

- **Cycle risk:** nothing prevents `A.parent = B` and `B.parent = A`. You must enforce "no cycles" in app code or a `CHECK` constraint. A migration trigger is the bulletproof option.
- **Cascade deletes wipe whole subtrees.** A `DELETE FROM categories WHERE id = 5` with `ON DELETE CASCADE` on `parent_id` will delete every descendant of 5. That is usually desired, but it will also cascade into `Qualifications`, `Prices`, `Experts` (your other FKs point at `categories.id`). Be deliberate — see §5.
- **Querying "all descendants"** needs a recursive CTE; a plain `find` with `where: { parent_id: 5 }` only gets *direct* children.

---

### 2.2 One-to-(Zero-or-One) — `Users` ↔ `Experts`

`Experts` has `user_id` as a FK, but a `User` may or may not be an expert. In SQL terms: `experts.user_id` is **nullable** and **unique**.

```ts
// user.entity.ts
@OneToOne(() => Expert, (expert) => expert.user)
expert?: Expert;

// expert.entity.ts
@OneToOne(() => User, (user) => user.expert, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true })   // unique enforces 0..1
user!: User;
```

The `unique: true` is doing the heavy lifting. **Never omit it.**

---

## 3. The Cardinality Cheat-Sheet Mapped to Your Schema

| drawio edge (left → right)                | TypeORM pair                                   | FK column            | `onDelete` recommendation |
|-------------------------------------------|------------------------------------------------|----------------------|---------------------------|
| `Users 1—1 Profiles`                      | `@OneToOne`/`@OneToOne` + `@JoinColumn`         | `profiles.user_id`   | `CASCADE`                 |
| `Users 1—1 Experts`                       | `@OneToOne`/`@OneToOne` + `@JoinColumn`         | `experts.user_id`    | `CASCADE`                 |
| `Users 1—N Posts`                         | `@OneToMany` + `@ManyToOne`                     | `posts.user_id`      | `CASCADE`                 |
| `Users 1—N Comments`                      | same                                           | `comments.user_id`   | `CASCADE`                 |
| `Users 1—N Reacts` (via Posts)            | same                                           | `reacts.user_id`     | `CASCADE`                 |
| `Users 1—N Channels`                      | same                                           | `channels.user_id`   | `CASCADE`                 |
| `Users 1—N Reviews`                       | same                                           | `reviews.user_id`    | `CASCADE`/`RESTRICT`      |
| `Users 1—N OTP`                           | same                                           | `otp.user_id`        | `CASCADE`                 |
| `Posts 1—N Reacts/Comments`               | same                                           | `reacts.post_id`     | `CASCADE`                 |
| `Categories 1—N self`                     | `@OneToMany`+`@ManyToOne` same entity           | `categories.parent_id` | `CASCADE` for soft trees, `RESTRICT` for protected roots |
| `Categories 1—N Experts`                  | same                                           | `experts.category_id` | `RESTRICT` (see §5)      |
| `Categories 1—N Qualifications`           | same (already in your code)                    | `qualifications.category_id` | `CASCADE`         |
| `Categories 1—N Prices`                   | same                                           | `prices.category_id` | `CASCADE`                 |
| `Experts 1—N Submissions`                 | same                                           | `submissions.expert_id` | `CASCADE`              |
| `Submissions 1—N Documents/Verifications` | same                                           | `documents.submission_id` | `CASCADE`           |
| `Experts M—N Qualifications`              | `@ManyToMany` + `@JoinTable`                   | `expert_qualifications` | `CASCADE` on both FKs   |
| `Experts M—N Organizations`               | `@ManyToMany` + `@JoinTable`                   | `expert_organizations` | `CASCADE`                |
| `Experts M—N Languages`                   | `@ManyToMany` + `@JoinTable`                   | `expert_languages`    | `CASCADE`                |
| `Experts M—N Prices`                      | `@ManyToMany` + `@JoinTable`                   | `expert_prices`       | `CASCADE`                |
| `Experts 1—N Reviews`                     | `@OneToMany` + `@ManyToOne`                    | `reviews.expert_id`  | `RESTRICT` (preserve history) |

> **Tip:** keep this table open in a second monitor while coding. Every time you add an entity, ask: which of these patterns is it, and which column owns the FK?

---

## 4. Joins: From TypeORM Code to SQL

TypeORM lets you write joins three ways. Pick by use case — never mix.

### 4.1 `relations` (simple, but limited)

```ts
const category = await this.repo.findOne({
  where: { id: 1 },
  relations: { qualifications: true, experts: true },
});
```

- Translates to **2 SQL queries** (one for category, one for qualifications, one for experts) — never a single JOIN. That's why it scales poorly for deep graphs.
- **When to use:** quick admin pages, one-shot scripts.

### 4.2 `leftJoinAndSelect` / `innerJoinAndSelect` (the workhorse)

```ts
const category = await this.repo
  .createQueryBuilder('c')
  .leftJoinAndSelect('c.qualifications', 'q')
  .leftJoinAndSelect('c.experts', 'e')
  .leftJoinAndSelect('e.user', 'u')
  .where('c.id = :id', { id: 1 })
  .getOne();
```

- Translates to a **single SQL query** with real `LEFT JOIN`s.
- **When to use:** anything you ship to production. This is what your future self will read in a slow-query log and understand.

### 4.3 `QueryBuilder` joins without selecting the joined entity (filtering only)

```ts
const expertIds = await this.repo
  .createQueryBuilder('e')
  .innerJoin('e.qualifications', 'q', 'q.id IN (:...ids)', { ids: [1, 2, 3] })
  .select('e.id')
  .getMany();
```

- **When to use:** the search journeys in `search-feature-planning.md`. You filter by joined rows but you don't need the joined rows in the response. Cheaper than `*AndSelect`.

### 4.4 Avoid this:

```ts
// ❌ The classic N+1
const categories = await this.repo.find();
for (const c of categories) {
  console.log(c.qualifications.length); // 1 + N queries
}
```

Fix it with `relations`, `*AndSelect`, or write the join yourself.

---

## 5. `onDelete`: Pick Deliberately. Every Time.

This is the most under-rated decision in your schema. Pick from four options; each has a real consequence.

| Option          | What Postgres does if parent is deleted                                  | Use when…                                                          |
|-----------------|--------------------------------------------------------------------------|--------------------------------------------------------------------|
| `CASCADE`       | Silently deletes all child rows                                          | Child is meaningless without parent (e.g. `Profiles` of a user)   |
| `RESTRICT`      | Refuses to delete the parent until children are removed                  | Parent has business meaning that must survive children (e.g. don't delete `Categories` while any `Expert` points at it) |
| `SET NULL`      | Child's FK becomes `NULL` (column must be nullable)                       | Child can exist orphaned (e.g. `Categories.parent_id`)            |
| `NO ACTION`     | Like `RESTRICT` but checked at commit time, not row time                  | Default; rarely what you want                                     |

**Your schema's actual exposure:**

- `experts.category_id` with `CASCADE` is **dangerous**: deleting one category wipes every expert under it, plus their submissions, reviews, pivot rows. That's a single SQL statement away from a customer-facing outage. Use `RESTRICT` here.
- `categories.parent_id` with `CASCADE` is **also dangerous** (deletes the entire subtree). Use `RESTRICT` for top-level categories; you can manually `CASCADE` from admin tooling.
- `users.*` with `CASCADE` is what you want — GDPR "right to be forgotten" needs to scrub everything about the user.
- `posts.*` with `CASCADE` is fine — when a post dies, its comments die.
- `reviews.*` with `CASCADE` from `experts` would destroy review history — prefer `RESTRICT`. From `users`, `CASCADE` is fine (reviewer deleted → review deleted).

**Rule of thumb:** *be liberal with `CASCADE` downward (child → grandchild), and conservative with `CASCADE` upward (parent → child). When in doubt, use `RESTRICT` and add an explicit deletion step in a service method.*

---

## 6. Performance & Indexing (what the diagram doesn't tell you)

A FK column is **not automatically indexed** by Postgres. Add `@Index()` explicitly. For your schema:

```ts
// high-cardinality lookups — must have indexes
@Index()
@Column(...)
user_id!: number;
```

Minimum index set for the `er-2.drawio` schema:

| Column                    | Why                                                  |
|---------------------------|------------------------------------------------------|
| `users.email`             | Login lookup (already `unique`)                      |
| `posts.user_id`           | "feed for this user"                                 |
| `posts.created_at`        | Reverse-chrono feed                                  |
| `comments.post_id`        | "all comments of a post"                             |
| `reacts(post_id, user_id)`| Composite unique prevents double-reacting; also an index |
| `reviews.expert_id`       | "all reviews of an expert"                           |
| `experts.category_id`     | "all experts in a category" — used by search         |
| `expert_qualifications(expert_id, qualification_id)` | Composite PK + doubles as index |
| `expert_languages(expert_id)` + `(language_id)`      | Both directions for search           |
| `expert_organizations(expert_id)` + `(organization_id)` | Both directions                  |
| `expert_prices(expert_id, price_id)`                 | Composite PK                       |
| `categories.parent_id`    | Walk the tree                                        |
| `submissions.expert_id`   | Admin queue lookups                                  |

**Don't forget the *covering* index.** For the search feature, a query like "active experts in category X with rating ≥ 4.5" will benefit from:

```sql
CREATE INDEX ON experts (category_id, avg_rating) WHERE status = 'active';
```

Partial indexes (`WHERE ...`) are cheap and very effective.

---

## 7. Best Practices Cheat-Sheet

1. **Always name the FK column explicitly.** `@JoinColumn({ name: 'category_id' })` — never let TypeORM auto-name, because later renames will hurt.
2. **One decorator pair per relationship.** Don't accidentally have two `@ManyToOne` to the same entity with the same `name` — silent breakage.
3. **Inverse sides exist for traversal only.** Mark them optional with `?` (e.g. `posts?: Post[]`) — they will be `undefined` after a `find` without `relations`.
4. **Composite PK on every pivot.** Either via `@JoinTable({ name: ... })` + migration composite PK, or via promoting the pivot to its own entity with `@PrimaryColumn` twice.
5. **Migrations own the FK rules.** TypeORM's `synchronize: true` (if you ever turn it on in dev) will create FKs without `ON DELETE` rules the way you expect. Always write a migration.
6. **Never use `Cascade: true` + `onDelete: 'CASCADE'` together without thinking.** One is TypeORM's "save children when I save parent"; the other is Postgres's "wipe children when parent dies". They serve different purposes and most of the time you only want one.
7. **Always `select: false` secrets.** Your `User.passwordHash` already does this. Extend the rule to OTP codes, document URLs behind signed URLs, etc.
8. **Soft-delete critical rows.** `Users.status = 'deleted'` already exists; mirror it on `Experts`, `Reviews`, `Posts`. Hard-deletes lose analytics data and can break search history.
9. **Test cascade behavior with real SQL.** TypeORM unit tests don't catch a missing `ON DELETE` clause — only running the migration against a real DB does.
10. **Document each `@JoinTable` in a one-line comment.** Six months from now you'll forget which column is `joinColumn` vs `inverseJoinColumn`.

---

## 8. Worked Examples (drawn directly from `er-2.drawio`)

### 8.1 "Show me an expert's profile + their primary category"

```ts
const expert = await this.expertRepo
  .createQueryBuilder('e')
  .leftJoinAndSelect('e.user', 'u')
  .leftJoinAndSelect('e.category', 'c')
  .leftJoinAndSelect('c.parent', 'cp')           // ← the tree
  .leftJoinAndSelect('e.qualifications', 'q')
  .where('e.id = :id', { id: 42 })
  .getOne();
```

Generated SQL (approximately):

```sql
SELECT e.*, u.*, c.*, cp.*, q.*
FROM experts e
LEFT JOIN users u       ON u.id = e.user_id
LEFT JOIN categories c  ON c.id = e.category_id
LEFT JOIN categories cp ON cp.id = c.parent_id
LEFT JOIN expert_qualifications eq ON eq.expert_id = e.id
LEFT JOIN qualifications q          ON q.id = eq.qualification_id
WHERE e.id = 42;
```

### 8.2 "All experts who speak Bangla and English, ordered by rating"

```ts
const experts = await this.expertRepo
  .createQueryBuilder('e')
  .innerJoin('e.languages', 'l1', 'l1.name = :a', { a: 'Bangla' })
  .innerJoin('e.languages', 'l2', 'l2.name = :b', { b: 'English' })
  .leftJoinAndSelect('e.user', 'u')
  .where('e.verification_status = :s', { s: 'verified' })
  .orderBy('e.avg_rating', 'DESC')
  .getMany();
```

This is exactly the query shape your `search-feature-planning.md` Journey 2 needs.

### 8.3 "Promote the `expert_qualifications` pivot to a real entity (because we now need `obtained_year`)"

When business data creeps into a pivot, stop using `@JoinTable`. Promote it:

```ts
@Entity('expert_qualifications')
@Index(['expert', 'qualification'], { unique: true })
export class ExpertQualification {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Expert, (e) => e.qualifications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'expert_id' })
  expert!: Expert;

  @ManyToOne(() => Qualification, (q) => q.experts, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'qualification_id' })
  qualification!: Qualification;

  @Column({ type: 'int', nullable: true })
  obtained_year!: number | null;
}
```

And replace the M:N on `Expert` with two 1:N. Yes, more code — but now you can store `obtained_year`, and queries on it are indexable.

---

## 9. Common Bugs and How to Spot Them

| Symptom in code                                                   | Likely cause                                                           | Fix                                          |
|-------------------------------------------------------------------|------------------------------------------------------------------------|----------------------------------------------|
| `expert.category` is `undefined` after `findOne`                  | You didn't `relations: ['category']` or `leftJoinAndSelect`            | Add the relation, or load it explicitly     |
| `category.qualifications` is `[]` for a category that has rows    | Inverse side declared without owning side, or property has wrong name   | Make sure both `@ManyToOne` and `@OneToMany` use the same field name |
| `QueryFailedError: duplicate key value violates unique constraint` | You forgot `unique: true` on a 1:1 FK                                  | Add `@JoinColumn({ ..., unique: true })`     |
| Slow list page                                                    | N+1 query — loop loads related entity                                  | Replace loop with `*AndSelect` or `relations` |
| Deleting a category deletes experts                               | `onDelete: 'CASCADE'` on `experts.category_id`                         | Switch to `RESTRICT`, add admin-only delete flow |
| Pivot table has duplicate rows                                   | Missing composite PK on `@JoinTable`                                    | Add composite PK in a migration             |
| `Cannot read property 'experts' of undefined` after service call | You serialized to DTO and DTO doesn't include the relation             | Move the relation to a `relations` response DTO |

---

## 10. Migration Recipe for Every New Relationship

When you add a relationship in code, your migration must:

1. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...(...)`.
2. Set `ON DELETE ...` explicitly — never rely on default.
3. Add the index (`CREATE INDEX ... ON ... (fk_column)`).
4. For pivots: add composite PK.
5. Write a `down` migration that drops the constraint, then the index, then the column. **Always.**
6. Run the migration against a *seeded* dev DB and execute the actual cascade by hand to confirm it does what you expect.

---

## 11. TL;DR for the Impatient

- `Users` is the root. Almost everything hangs off it.
- `Profiles` and `Experts` are `1:1` extensions of `Users` — both use `unique: true` on the FK.
- `Categories` is a tree; treat the root as immutable, cascade-delete only via admin tooling.
- Posts/Reacts/Comments/Channels/Reviews/OTP are plain `1:N` children of `Users` (and Posts).
- Experts connect to four lookups (Qualifications, Organizations, Languages, Prices) via pivots — all four will eventually want their own entity once business columns arrive.
- **Every FK needs an `onDelete` decision and an index. Make both explicit.**
- **Prefer `leftJoinAndSelect` in services. Reserve `relations` for one-off scripts.**

That's the entire schema in your head. Now go open `backend/src/categories/categories.service.ts` and read it with this lens — you'll spot at least three decisions that should be revisited once you're comfortable.
