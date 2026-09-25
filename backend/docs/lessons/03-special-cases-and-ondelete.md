# Lesson 03 — Special Cases, `onDelete`, and Indexes

> **What you'll get:** the two "weird" relationships in your schema (self-referencing trees, 0..1 extensions), the entire `onDelete` decision matrix, the FK-indexing rules, and the recipe for promoting a pivot to a real entity when business data creeps in.
>
> **Why this lesson exists:** Lesson 02 covered the three base relationships. Lesson 03 covers the five decisions that turn "it works" into "it works in production": how do children behave when their parent dies (CASCADE vs RESTRICT), how do you index a FK for fast lookups, and how do you model the recursive tree in `Categories` and the nullable expert extension in `Users`.
>
> **Prerequisites:** Lesson 02 (you must be fluent with 1:1, 1:N, M:N).

---

## 1. Goal

By the end of this lesson you can:

1. Model a self-referencing tree (`Categories.parent_id`) with `nullable: true` + `ON DELETE CASCADE` (or `RESTRICT` for protected roots).
2. Model a 0..1 extension (`Users ↔ Experts`) with `nullable: true` + `unique: true`.
3. Pick the right `onDelete` for any FK in your schema, and justify the choice in one sentence.
4. Explain why `experts.category_id` with `CASCADE` is a customer-facing outage waiting to happen, and how to prevent it.
5. Identify which FK columns in your schema need an index, and write the migration.
6. Decide when to promote an implicit `@JoinTable` pivot to a real `@Entity()`, and execute the migration safely.
7. Recognize the cycle hazard in self-referencing trees and write a defense.

---

## 2. Why this matters

The decisions in this lesson are the ones that, when wrong, take down production systems quietly. Three real examples from real codebases (paraphrased to protect the guilty):

- **The category wipe.** A junior engineer chose `ON DELETE CASCADE` for `experts.category_id` because the diagram looked clean. A product manager renamed a category, the cascade deleted 1,200 experts, and the team spent a Saturday restoring from backups. The fix is `RESTRICT`, plus an explicit "move children then delete" admin tool.
- **The recursive runaway.** A status update script tried to "delete the inactive categories" with a plain `DELETE`. The CASCADE on `parent_id` deleted every descendant in every branch, then the CASCADE on `experts.category_id` deleted the experts, then the CASCADE on `submissions.expert_id` deleted the submissions. One query, three hours of incident.
- **The pivot that wouldn't scale.** `expert_qualifications` started as a `@JoinTable` pivot. Six months later, product wanted `obtained_year` and `verified_at`. The team hacked JSON columns onto the pivot instead of promoting it. Six months after that, they couldn't query "experts who got their degree after 2010". The team had to migrate the entire pivot to an entity anyway.

None of these were bugs in the *code*. They were bugs in the *schema decisions*. This lesson is the rubric for not making them.

---

## 3. Special case 1 — the self-referencing tree

### 3.1 What it is

A table that points at itself. In your schema: `Categories.parent_id` references `Categories.id`. This is how you model "categories have sub-categories have sub-categories".

```text
Medical
├── Cardiology
│   ├── Interventional
│   └── Pediatric
├── Neurology
└── Dermatology
```

### 3.2 The pattern (1:N from a table to itself)

```ts
// categories.entity.ts (already in your code)
@ManyToOne(() => Category, (category) => category.children, {
  onDelete: 'RESTRICT',     // ← root categories are protected
  nullable: true,             // ← top-level categories have no parent
})
@JoinColumn({ name: 'parent_id' })
parent!: Category | null;

@OneToMany(() => Category, (category) => category.parent)
children!: Category[];
```

Two decorators, same entity, same relationship, both directions. The `@ManyToOne` is the owning side; `@OneToMany` is the inverse.

### 3.3 The nullable parent

`Categories.parent_id` must be nullable — a top-level category has no parent. `nullable: true` lets the column be `NULL`. There's no top-level-marker row; absence is the marker.

### 3.4 The cycle hazard

Nothing in SQL prevents `A.parent = B` and `B.parent = A`. You must enforce "no cycles" in app code, or with a check constraint, or — the bulletproof option — a Postgres trigger:

```sql
CREATE OR REPLACE FUNCTION prevent_category_cycle()
RETURNS trigger AS $$
DECLARE
  pid INT;
BEGIN
  pid := NEW.parent_id;
  WHILE pid IS NOT NULL LOOP
    IF pid = NEW.id THEN
      RAISE EXCEPTION 'Category cycle detected: % -> %', NEW.id, pid;
    END IF;
    SELECT parent_id INTO pid FROM categories WHERE id = pid;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_category_cycle
BEFORE INSERT OR UPDATE OF parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION prevent_category_cycle();
```

This walks up the chain on every update. On your data sizes (categories in the hundreds) the cost is negligible. The protection is total.

### 3.5 Recursive queries — "all descendants of Cardiology"

A plain `find` only gets direct children. To get the full subtree, use a recursive CTE:

```sql
WITH RECURSIVE category_tree AS (
  SELECT id, parent_id, name, 0 AS depth
  FROM categories
  WHERE id = $1                    -- start: Cardiology

  UNION ALL

  SELECT c.id, c.parent_id, c.name, ct.depth + 1
  FROM categories c
  JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT * FROM category_tree
ORDER BY depth, name;
```

Postgres handles this natively; no extensions. Wire it into TypeORM with `createQueryBuilder().from(...).select(...)` and a raw SQL fragment, or define it as a view.

### 3.6 The cascade decision for `parent_id`

| Choose                    | When                                                                       |
|---------------------------|----------------------------------------------------------------------------|
| `CASCADE`                 | Deleting a category should wipe its entire subtree (e.g. "remove this deprecated branch") |
| `RESTRICT`                | Root categories are protected; deletion must be explicit (the right default for you) |

For your app: **`RESTRICT` is the safe default**. Add an admin-only "delete subtree" operation that explicitly deletes children first. This makes accidental `DELETE FROM categories WHERE id = X` a no-op instead of a customer-facing outage.

---

## 4. Special case 2 — the 0..1 extension

### 4.1 What it is

A row in A has *zero or one* matching row in B. In SQL terms: the FK is nullable *and* unique. In your schema: `Experts.user_id` — most users are not experts, but every expert must be a user.

### 4.2 The pattern

```ts
// user.entity.ts (the inverse side — no @JoinColumn)
@OneToOne(() => Expert, (expert) => expert.user)
expert?: Expert;
```

```ts
// expert.entity.ts (the owning side)
@OneToOne(() => User, (user) => user.expert, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true })     // ← unique: true enforces "at most one"
user!: User;
```

Two things make this "0..1" instead of "1":

1. **`unique: true`** — DB refuses a second expert row pointing at the same user.
2. **`nullable: true` is implicit on a 1:1 if you want 0..1** — but since `Experts.user_id` is required (every expert is a user), keep it `nullable: false`. The "0" is on the *other* side: most users have no `expert` row.

### 4.3 Why `unique: true` is doing the heavy lifting

The "0..1" semantics live in two places: the `unique` constraint on `experts.user_id`, and the absence of an `experts` row for non-expert users. The query "is this user an expert?" is:

```sql
SELECT * FROM experts WHERE user_id = $1;   -- returns 0 or 1 row
```

If you forget `unique: true`, the query can return two rows. Your UI shows "this user is two different experts". Your `findOne` returns the first row. Your users see ghost data. The composite PK on `(id)` plus `unique` on `user_id` is the entire defense.

### 4.4 The cascade decision for `user_id`

`ON DELETE CASCADE`. When a user is deleted, the expert row goes with them. This is the GDPR "right to be forgotten" path. If you choose `RESTRICT`, you can't delete a user who is an expert without first deleting the expert — usually not what you want.

---

## 5. `onDelete` — the decision matrix

This is the single most leveraged decision in the schema. Pick deliberately for every FK. The four options:

| Option       | What Postgres does if parent is deleted                                       | When to use                                                                                  |
|--------------|--------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| `CASCADE`    | Silently deletes all child rows                                                | Child is meaningless without parent (Profiles of a deleted User, OTP of a deleted User)    |
| `RESTRICT`   | Refuses to delete the parent until children are removed (raises an error)     | Parent has business meaning that must survive children (don't delete Category while Experts exist) |
| `SET NULL`   | Child's FK becomes `NULL` (column must be nullable)                            | Child can exist orphaned (Comments when the User is gone, if you keep the comment for moderation) |
| `NO ACTION`  | Like `RESTRICT` but checked at commit time, not row time                       | Default; rarely what you want                                                                 |

### 5.1 The rule of thumb

> **Be liberal with CASCADE downward (child → grandchild) and conservative with CASCADE upward (parent → child). When in doubt, use RESTRICT and add an explicit "move children then delete" admin operation.**

"Downward" means: the FK is on the child side and the relationship is "child belongs to parent". If parent dies, child has no meaning → CASCADE.

"Upward" means: deleting the parent would wipe grandchildren as well. That's the danger zone. CASCADE upward is almost always wrong for top-of-tree parents.

### 5.2 The decisions for your schema

Every FK in `er-2.drawio`, with my recommendation and the reason:

| FK column                                  | Recommended `onDelete` | Why                                                                                  |
|--------------------------------------------|------------------------|--------------------------------------------------------------------------------------|
| `profiles.user_id`                         | `CASCADE`              | Profile is meaningless without user (GDPR)                                            |
| `experts.user_id`                          | `CASCADE`              | Expert extension dies with the user                                                   |
| `posts.user_id`                            | `CASCADE`              | Posts are owned by the user; user deletion scrubs them                                |
| `comments.user_id`                         | `CASCADE`              | Same as posts                                                                        |
| `reacts.user_id`                           | `CASCADE`              | Reactions die with the user                                                          |
| `channels.user_id`                         | `CASCADE`              | Channels are owned by the user                                                       |
| `reviews.user_id`                          | `CASCADE`              | Reviewer's review dies with them (NOT the expert's review history — see below)        |
| `reviews.expert_id`                        | `RESTRICT`             | Don't lose review history if an expert is deleted (soft-delete instead)              |
| `otp.user_id`                              | `CASCADE`              | OTPs are useless after user is gone                                                  |
| `posts.id` ← `reacts.post_id`              | `CASCADE`              | Reactions die with the post                                                           |
| `posts.id` ← `comments.post_id`            | `CASCADE`              | Comments die with the post                                                           |
| `categories.id` ← `categories.parent_id`   | `RESTRICT`             | Protect root categories from accidental cascade-wipe                                 |
| `categories.id` ← `experts.category_id`    | `RESTRICT`             | Don't wipe experts by renaming/merging categories                                    |
| `categories.id` ← `qualifications.category_id` | `CASCADE`          | Qualifications belong to their category; drop them if category drops                  |
| `categories.id` ← `prices.category_id`     | `CASCADE`              | Prices belong to their category; drop them if category drops                         |
| `experts.id` ← `submissions.expert_id`     | `CASCADE`              | Submissions are part of an expert's lifecycle                                        |
| `experts.id` ← `reviews.expert_id`         | `RESTRICT`             | Preserve review history                                                              |
| `submissions.id` ← `documents.submission_id` | `CASCADE`            | Documents belong to a submission                                                      |
| `submissions.id` ← `verifications.submission_id` | `CASCADE`        | Verifications belong to a submission                                                 |
| `experts.id` ← `expert_qualifications.expert_id` | `CASCADE`        | Pivot row is meaningless without expert                                              |
| `qualifications.id` ← `expert_qualifications.qualification_id` | `CASCADE` | Pivot row is meaningless without qualification                                  |
| `experts.id` ← `expert_languages.expert_id` | `CASCADE`            | Same                                                                                 |
| `languages.id` ← `expert_languages.language_id` | `CASCADE`         | Same                                                                                 |
| `experts.id` ← `expert_organizations.expert_id` | `CASCADE`        | Same                                                                                 |
| `organizations.id` ← `expert_organizations.organization_id` | `CASCADE` | Same                                                                                |
| `experts.id` ← `expert_prices.expert_id`   | `CASCADE`              | Same                                                                                 |
| `prices.id` ← `expert_prices.price_id`     | `CASCADE`              | Same                                                                                 |

### 5.3 The "danger zone" pairs

Three FKs where CASCADE is *catastrophic* if you get it wrong. Re-read this list before you let `synchronize: true` anywhere near your DB:

1. **`experts.category_id` with `CASCADE`** — deleting one category wipes every expert under it, plus their submissions, reviews, pivot rows. A single SQL statement away from a customer-facing outage. **Use RESTRICT.**
2. **`categories.parent_id` with `CASCADE`** — deleting one node deletes its entire subtree, which then cascades into `Qualifications`, `Prices`, and (if you mis-configured) `Experts`. **Use RESTRICT.**
3. **`reviews.expert_id` with `CASCADE`** — destroys review history. **Use RESTRICT.** Soft-delete the expert instead.

### 5.4 How to enforce RESTRICT in practice

When you RESTRICT a delete, your admin code has to:

1. Detect that the entity has children.
2. Decide what to do with the children (move to a new parent? soft-delete them? reassign?).
3. Move/reassign/delete the children explicitly.
4. Then delete the parent.

This is a service-layer concern. The DB does the right thing automatically (refuses to delete). The admin tool does the right UX thing (explicit "this will affect 47 experts — proceed?").

---

## 6. Indexes on FKs

### 6.1 Why you need them

A foreign-key column is **not automatically indexed** by Postgres. If you `SELECT * FROM posts WHERE user_id = 5`, Postgres does a sequential scan unless there's an index on `posts.user_id`. At 100k posts, that's seconds. With the index, milliseconds.

This is the most common performance bug in early Postgres schemas. The fix is one line per FK.

### 6.2 The minimum index set for your schema

A FK is "must index" if any of:

- You query "all rows for parent X" (`WHERE user_id = X`, `WHERE category_id = X`).
- You join on it (`LEFT JOIN experts e ON e.category_id = c.id`).
- You sort by it (`ORDER BY category_id`).

The minimum index set:

| Column                                  | Why                                                                  |
|-----------------------------------------|----------------------------------------------------------------------|
| `users.email`                           | Login lookup (already `unique`, which creates an index)               |
| `posts.user_id`                         | "Feed for this user"                                                 |
| `posts.created_at`                      | Reverse-chrono feed                                                  |
| `comments.post_id`                      | "All comments of a post"                                             |
| `reacts(post_id, user_id)`              | Composite UNIQUE prevents double-reacting; doubles as an index       |
| `reviews.expert_id`                     | "All reviews of an expert"                                           |
| `experts.category_id`                   | "All experts in a category" — used by search                         |
| `expert_qualifications(expert_id, qualification_id)` | Composite PK + doubles as an index                       |
| `expert_languages(expert_id)` + `(language_id)`   | Both directions for search                            |
| `expert_organizations(expert_id)` + `(organization_id)` | Both directions                                |
| `expert_prices(expert_id, price_id)`    | Composite PK                                                         |
| `categories.parent_id`                  | Walk the tree                                                        |
| `submissions.expert_id`                 | Admin queue lookups                                                  |

### 6.3 TypeORM decorator pattern

```ts
@Index()                          // single-column index
@Column({ ... })
user_id!: number;

@Index(['post_id', 'user_id'], { unique: true })   // composite unique index
@ManyToOne(...)
post!: Post;
```

TypeORM will emit `CREATE INDEX` for non-unique `@Index()` decorators and a unique constraint (which creates a backing index) for `@Index({ unique: true })`. The composite PK on pivots goes in a migration; TypeORM does not emit it automatically.

### 6.4 Partial indexes — the cheap superpower

For the search feature (Lesson 30/40), queries like "active experts in category X with rating ≥ 4.5" benefit from a *partial* index:

```sql
CREATE INDEX ON experts (category_id, avg_rating) WHERE status = 'active';
```

Partial indexes are tiny (they only index the rows matching the `WHERE`), and Postgres can use them when your query's `WHERE` matches the partial predicate. They are almost always faster than a full index when you only ever query a subset.

Rule: any time you write `WHERE status = 'active'` in a hot query, add a partial index on the other columns of the same query.

### 6.5 Don't over-index

Indexes speed up reads but slow down writes (every INSERT/UPDATE/DELETE has to maintain the index). The "every FK gets an index" rule has a ceiling — for a write-heavy column you may skip it. For your schema, with the read-heavy workloads in mind, default to indexing everything and revisit when you measure write contention.

---

## 7. Promoting a pivot to an entity

### 7.1 When to do it

The day product asks for *any* column on the pivot:

- `expert_qualifications.obtained_year`
- `expert_languages.level` ('native' | 'conversational')
- `expert_organizations.started_at`, `ended_at`
- `expert_prices.currency` (when you go multi-currency)

If you ignore the request and add a JSON column on the pivot, you've made the schema un-queryable. If you promote to an entity, you've added an indexable column.

### 7.2 The pattern

**Before** — implicit pivot via `@JoinTable`:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts)
@JoinTable({
  name: 'expert_qualifications',
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

**After** — explicit entity, two 1:Ns:

```ts
// expert-qualification.entity.ts (NEW)
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
  obtainedYear!: number | null;
}
```

```ts
// expert.entity.ts (REPLACE @ManyToMany with @OneToMany)
@OneToMany(() => ExpertQualification, (eq) => eq.expert)
qualifications!: ExpertQualification[];
```

```ts
// qualification.entity.ts (REPLACE @ManyToMany with @OneToMany)
@OneToMany(() => ExpertQualification, (eq) => eq.qualification)
experts!: ExpertQualification[];
```

### 7.3 The migration recipe

You need a *forward* migration that:

1. Drops the old composite PK constraint (if any).
2. Adds the new `id` column as `bigserial PRIMARY KEY` (or `serial`).
3. Adds the `obtained_year` column.
4. Drops the foreign keys on the old composite PK columns (or recreates them as plain FKs to the new entity).
5. Backfills the new column from any existing JSON (if you've been cheating).

And a `down` migration that:

1. Drops the `id` column.
2. Drops the `obtained_year` column.
3. Recreates the composite PK.

This is a *non-trivial* migration. Test it on a copy of prod data before running it.

### 7.4 When *not* to promote

If the only thing on the pivot is `(a_id, b_id)` and that's all it will ever be, stay on `@JoinTable`. The cost of the implicit pivot is zero; the cost of an explicit entity is a join on every read. If you don't need the columns, don't pay for them.

---

## 8. Worked example — auditing one FK end-to-end

Take `experts.category_id`. Walk through the rubric:

**1. What is the cardinality?** Many-to-one (many experts per category). FK lives on `experts`.

**2. What is the nullable policy?** `nullable: false` — every expert must have a category.

**3. What is the `onDelete`?** **`RESTRICT`**. Deleting a category should never wipe experts. The admin tool should explicitly reassign first.

**4. Does it need an index?** Yes — search by category is a core query (`/search/experts?category_id=X`).

**5. Is there a unique constraint?** No — many experts per category, so a unique constraint would be wrong.

**6. The code:**

```ts
// expert.entity.ts
@Index()                                          // for fast "all experts in category" lookups
@ManyToOne(() => Category, (category) => category.experts, {
  onDelete: 'RESTRICT',
  nullable: false,
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

**7. The migration:**

```sql
-- Forward
ALTER TABLE experts
  ADD CONSTRAINT fk_experts_category
  FOREIGN KEY (category_id) REFERENCES categories(id)
  ON DELETE RESTRICT;                            -- explicit; never trust default

CREATE INDEX idx_experts_category ON experts (category_id);

-- Down
DROP INDEX IF EXISTS idx_experts_category;
ALTER TABLE experts DROP CONSTRAINT fk_experts_category;
```

**8. The smoke test:**

```ts
// in a test
const cat = await categoryRepo.findOne({ where: { id: catId } });
await expect(categoryRepo.delete(catId)).rejects.toThrow();  // RESTRICT refuses
```

That's the entire workflow. Apply it to every FK.

---

## 9. Decision summary

Before you commit any new FK, answer these five questions in a comment above the decorator:

```ts
@ManyToOne(() => Category, (c) => c.experts, {
  // 1. Cardinality: Many-to-One (each expert has one category; each category has many experts)
  // 2. Nullable: false (every expert must have a category)
  // 3. onDelete: RESTRICT (don't wipe experts by renaming categories)
  // 4. Index: yes (used by /search/experts?category_id=X)
  // 5. Unique: no (many experts per category)
  onDelete: 'RESTRICT',
  nullable: false,
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

If you can't answer one, you don't understand the FK well enough to ship it.

---

## 10. Common mistakes

1. **Picking `CASCADE` for everything "because it's simpler".** It is simpler for one day. It is catastrophic on the day someone runs a `DELETE` they didn't mean to.
2. **Skipping the index on a FK.** Postgres doesn't do it for you. Sequential scans on FK columns are the most common "why is the API slow?" bug.
3. **Picking `NO ACTION` because it's the default.** It's not what you want. Be deliberate.
4. **Forgetting `nullable: true` on a self-ref FK.** Top-level rows must be able to have no parent.
5. **Forgetting `unique: true` on a 0..1 FK.** Allows duplicate extensions; corrupts the model.
6. **Adding business columns to the implicit `@JoinTable` pivot.** Promote to entity.
7. **No cycle protection on the recursive tree.** Cycle rows break every "walk the tree" query.
8. **Forgetting the secondary index on the inverse-FK side of a pivot.** `expert_qualifications(expert_id)` is your "qualifications of an expert" lookup. The PK gives you `expert_id` for free. The other side (`qualification_id`) needs its own index for "experts with this qualification".
9. **Trusting TypeORM's `synchronize: true` to set up FKs the way you expect.** It often picks the default `NO ACTION`. Always write the migration explicitly.
10. **No migration `down`.** If you can't reverse the change, you have a non-reversible change, and you should think twice about doing it.

---

## 11. Self-check

Answer these in writing before moving to Lesson 04.

1. Why is `nullable: true` necessary on `categories.parent_id`? What goes wrong if you set it to `false`?
2. Why does `experts.user_id` need `unique: true` even though every expert *should* have a user?
3. For each of `experts.category_id`, `posts.user_id`, `reviews.expert_id`, state the correct `onDelete` and a one-sentence reason.
4. Why does Postgres *not* automatically index foreign-key columns? What is the most common symptom?
5. Write the migration for adding `idx_experts_category` on `experts(category_id)` including the FK with `ON DELETE RESTRICT`. Include the down.
6. When should you promote `@JoinTable` to an entity? Give three concrete examples from your schema.
7. Why is `ON DELETE CASCADE` on `categories.parent_id` dangerous? What should you use instead?
8. What is the cycle hazard in self-referencing trees, and what are two defenses?
9. For `expert_languages`, list the indexes you need. Why does each direction need its own index?
10. Why is `NO ACTION` rarely what you want, even though it's the Postgres default?

When you can answer all ten in two sentences each, go to **Lesson 04**.
