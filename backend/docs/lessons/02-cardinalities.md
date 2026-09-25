# Lesson 02 — Cardinalities: The Three Relationships in Your Schema

> **What you'll get:** a working vocabulary for the *only three relationships that exist* in your schema (one-to-one, one-to-many, many-to-many), the TypeORM decorator pair that implements each, and the rule for deciding which side "owns" the foreign key. By the end you should be able to look at any line in `er-2.drawio` and write its entity code without checking the docs.
>
> **Why this lesson exists:** every Lesson 05+ assumes you know what an "owning side" is, why `@JoinColumn` only goes on one side, and what `@ManyToMany` actually does behind the scenes. If you skip it, you'll write code that "looks right" and returns `undefined` for related rows at runtime — the most common silent breakage in TypeORM.
>
> **Prerequisites:** Lesson 00. You should have `er-2.drawio` open in another tab.

---

## 1. Goal

By the end of this lesson you can:

1. Look at any edge in `er-2.drawio` and state its cardinality in one word: `1:1`, `1:N`, or `M:N`.
2. Identify the **owning side** of any relationship from the diagram (the table whose row contains the FK column).
3. Write the `@OneToOne`, `@OneToMany` / `@ManyToOne`, and `@ManyToMany` decorator pair without consulting this file.
4. Explain why `@JoinColumn` is only ever declared on one side.
5. State, from memory, the three rules that prevent `@ManyToMany` silent breakage: composite PK on the pivot, `@JoinTable` on exactly one side, no business columns on the implicit pivot.

---

## 2. Why this matters — the silent `undefined`

Three quarters of the bugs in this codebase will be relationship bugs. They look like:

```ts
const category = await this.categoriesService.findOne(5);
console.log(category.qualifications); // ← what do you expect?
```

If you answered `[]` (because the category has qualifications), you're going to spend a confused hour learning that the inverse side of a relationship is **lazy by default** — it's `undefined` until you either declare it `eager: true`, pass `relations` in the find options, or use `leftJoinAndSelect`. The TypeORM compiler will not warn you. The runtime will not throw. Your code will silently fail.

This lesson is the antidote. Once you understand *what a relationship is in TypeORM* — a pair of decorators that **describe** a relationship, plus an opt-in mechanism that **loads** it — you'll never write that bug again.

---

## 3. The three relationships

There are exactly three. Every edge in `er-2.drawio` is one of them, plus two special-case variants we'll cover in Lesson 03.

| Type       | Also called            | Has FK column on   | Cardinality in your schema                                                  |
|------------|------------------------|---------------------|------------------------------------------------------------------------------|
| `1:1`      | One-to-One             | "Child" side        | `Users ↔ Profiles`, `Users ↔ Experts`                                         |
| `1:N`      | One-to-Many / Many-to-One | "Many" side       | `Users → Posts`, `Categories → Experts`, `Posts → Comments`, etc. (most of your schema) |
| `M:N`      | Many-to-Many           | A separate pivot table | `Experts ↔ Qualifications`, `Experts ↔ Languages`, `Experts ↔ Organizations`, `Experts ↔ Prices` |

That's it. Anything more complicated is a combination of these three.

The pattern that makes everything click: **the table that holds the FK column is the owning side of the relationship**. The other side is the *inverse* side, declared only so you can traverse from parent to child without writing a separate query.

---

## 4. One-to-One (1:1)

### 4.1 What it means

Each row in table A has **at most one** matching row in table B, and vice versa. In your schema:

- `Users ↔ Profiles`: each user has zero-or-one profile (you may add a profile later, after registration).
- `Users ↔ Experts`: each user has zero-or-one expert extension (most users are clients, not experts).

Both are **0..1 to 1** — they look like 1:1 in the diagram but allow the "0" on one side. The way to express "at most one" in SQL is `UNIQUE` on the FK column.

### 4.2 The rule

- Pick the side that **holds the FK** — it gets `@JoinColumn`.
- The other side is the **inverse** — it does *not* get `@JoinColumn`.
- The FK column **must** be `unique: true` (this is what enforces "at most one" at the DB level).
- The FK column can be `nullable: true` (for `0..1:1`) or `nullable: false` (for `1:1` — every user *must* have a profile).

### 4.3 The TypeORM pattern, applied to your code

For `Users ↔ Profiles`, where `profiles.user_id` is the FK:

```ts
// user.entity.ts
@OneToOne(() => Profile, (profile) => profile.user)
profile?: Profile;
```

```ts
// profile.entity.ts
@OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })
@JoinColumn({ name: 'user_id', unique: true }) // ← unique: true is non-negotiable
user!: User;
```

Walk through what each decorator does:

- `@OneToOne(() => Profile, (profile) => profile.user)` on `User` declares that there's a relationship, names the *other* entity, and gives TypeORM the inverse-side property name. It does **not** create a column.
- `@OneToOne(() => User, (user) => user.profile, { onDelete: 'CASCADE' })` on `Profile` declares the same relationship from the other side.
- `@JoinColumn({ name: 'user_id', unique: true })` on `Profile` tells TypeORM "this side owns the FK; create a column called `user_id` and make it unique". This is the **only** place a column is created. The inverse side gets no `@JoinColumn`.

### 4.4 Common 1:1 bugs

| Symptom                                                          | Cause                                                          | Fix                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| `duplicate key value violates unique constraint` on insert       | Two profiles for one user — `unique: true` missing             | Add `unique: true` to `@JoinColumn`                  |
| `user.profile` is `undefined` after `findOne`                    | Inverse side is lazy; you didn't `relations: ['profile']`     | Load explicitly (Lesson 04)                          |
| Deleting a user does **not** delete their profile                | Missing `onDelete: 'CASCADE'` on the owning side              | Add it on `Profile.user`                             |
| `user.profile` returns the same object even after mutation       | Inverse-side cache                                              | Use `relations` per call, not a cached property      |

### 4.5 Why `1:1` is worth the trouble

Putting all PII on `User` looks tempting. It is wrong:

- Every `SELECT *` on `User` returns `passwordHash`, even in JSON responses that go to the frontend. `select: false` saves you on the password hash column, but it's a column-by-column escape hatch, not a structural defense.
- You can't soft-delete a profile without deleting auth.
- If you ever support "two profiles per user" (e.g. personal + business), you're stuck — you'd have to split the table anyway.

Splitting `Users` (auth identity) from `Profiles` (PII) is one of the most leveraged design decisions in the codebase. It looks like over-engineering the first day and pays for itself every day after.

---

## 5. One-to-Many / Many-to-One (1:N)

### 5.1 What it means

One row in the "parent" table has many rows in the "child" table; each child belongs to exactly one parent. This is the **workhorse** of your schema — most edges in `er-2.drawio` are 1:N.

Examples in your schema:

- `Users 1—N Posts` (a user has many posts)
- `Users 1—N Channels`
- `Posts 1—N Comments` (a post has many comments)
- `Posts 1—N Reacts`
- `Experts 1—N Submissions`
- `Submissions 1—N Documents`
- `Categories 1—N Experts`
- `Categories 1—N Qualifications`
- `Categories 1—N Prices`

### 5.2 The rule

- The "many" side has the FK column. It declares `@ManyToOne` and `@JoinColumn`.
- The "one" side declares `@OneToMany`. **It does not get `@JoinColumn`.**
- Both decorators must reference each other by property name (`(parent) => parent.children`, `(child) => child.parent`). If you miss the property-name callback, you'll get `undefined` at runtime.
- The FK column should be **indexed** (Lesson 03 covers the rules).

### 5.3 The TypeORM pattern, applied to your code

For `Categories 1—N Experts`, where `experts.category_id` is the FK:

```ts
// categories.entity.ts (the "one" side — already in your code)
@OneToMany(() => Expert, (expert) => expert.category)
experts!: Expert[];
```

```ts
// expert.entity.ts (the "many" side — owns the FK)
@ManyToOne(() => Category, (category) => category.experts, {
  onDelete: 'RESTRICT',  // see Lesson 03 for the full decision matrix
  nullable: false,        // every expert must have a category
})
@JoinColumn({ name: 'category_id' })
category!: Category;
```

### 5.4 The two-decorator rule

This is the most-violated rule in beginner TypeORM code. **A 1:N relationship requires two decorators in two different files, and both must reference each other by property name.** If you declare only one, you get a silent runtime `undefined`.

```ts
// category.entity.ts
@OneToMany(() => Expert, (expert) => expert.category) // ← 'category' must match the property on Expert
experts!: Expert[];
```

```ts
// expert.entity.ts
@ManyToOne(() => Category, (category) => category.experts) // ← 'experts' must match the property on Category
@JoinColumn({ name: 'category_id' })
category!: Category;
```

If the property names drift (`category` vs `cat`, `experts` vs `expertList`), TypeORM will not warn you. Add a smoke test: load a category with `relations: ['experts']`, assert the array has the rows you expect. We'll wire that test in Lesson 04.

### 5.5 What `@OneToMany` actually does

Almost nothing. `@OneToMany(() => Expert)` on `Category` does not create a column on `categories`. It does not enforce anything. It is a **declaration** that "if you ask, here is where the related rows are". The mechanism that *loads* those rows is in Lesson 04.

This is why the inverse side of a 1:N is optional in your DTOs. Mark it with `?`:

```ts
export class CategoryResponseDto {
  id!: number;
  name!: string;
  experts?: Expert[];   // ← undefined until you load it
}
```

### 5.6 Common 1:N bugs

| Symptom                                                       | Cause                                                          | Fix                                                  |
|---------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| `category.experts` is `undefined`                             | Inverse side is lazy by default                               | `relations: ['experts']` in find options              |
| `category.experts` is `[]` for a real parent                  | Property name in the callback mismatches                       | Make both decorators reference the same field name   |
| Loading 100 experts takes 100ms per expert for the category   | N+1 — you did `expert.category` in a loop                     | Use `leftJoinAndSelect` (Lesson 04)                  |
| `experts: undefined` in JSON response                         | DTO stripped it                                                | Keep inverse-side fields in the response DTO         |

---

## 6. Many-to-Many (M:N)

### 6.1 What it means

Each row in A can relate to many rows in B, and each row in B can relate to many rows in A. In SQL, there is no direct M:N — you introduce a **pivot table** with two FK columns.

In your schema:

- `Experts ↔ Qualifications` (an expert has many qualifications; a qualification belongs to many experts)
- `Experts ↔ Organizations`
- `Experts ↔ Languages`
- `Experts ↔ Prices`

These four pivots (`expert_qualifications`, `expert_organizations`, `expert_languages`, `expert_prices`) are how `er-2.drawio` encodes "an expert speaks Bangla *and* English *and* Hindi".

### 6.2 Why a pivot table, not a JSON column?

A reasonable question: why not store `expert.languages = ['en', 'bn']` as a `text[]` column?

Two reasons:

1. **You can't index inside a JSON/array column cheaply.** "Find all experts who speak Bangla and English" becomes a sequential scan with `WHERE 'bn' = ANY(languages) AND 'en' = ANY(languages)`. On 100k experts, that's seconds. With a pivot table and two indexed FK columns, it's a few milliseconds.
2. **You can't add columns to a JSON/array.** The day you want `expert_languages(level: 'native' | 'conversational')` or `obtained_year` on qualifications, you're migrating again. The pivot is already shaped right.

There is one tradeoff: more joins in read queries. We pay that with the index design in Lesson 03 and the `leftJoinAndSelect` pattern in Lesson 04.

### 6.3 The rule

- Declare `@ManyToMany` on **both** entities (the inverse side is *not* optional for M:N — TypeORM needs it to resolve the pivot).
- Declare `@JoinTable` on **exactly one** side — the side whose FK is named first in the pivot (`joinColumn`). The other side is silent.
- The pivot table needs a **composite primary key** `(a_id, b_id)` — add it in a migration; TypeORM's `@JoinTable` does not add it.
- The pivot table needs **`ON DELETE CASCADE`** on both FK columns — TypeORM cannot infer this; you must write it.
- **Never put business columns on the implicit pivot** (timestamps, `is_verified`, etc.). The moment you need a column, **promote the pivot to a real entity** (two 1:Ns instead of one M:N). Lesson 03 has the recipe.

### 6.4 The TypeORM pattern, applied to your code

For `Experts ↔ Qualifications`, where the pivot is `expert_qualifications`:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts, { cascade: true })
@JoinTable({
  name: 'expert_qualifications',                  // match the table name in er-2.drawio exactly
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

```ts
// qualification.entity.ts
@ManyToMany(() => Expert, (e) => e.qualifications)   // ← no @JoinTable here!
experts!: Expert[];
```

And in a migration (TypeORM will not do this for you):

```sql
ALTER TABLE expert_qualifications
  ADD CONSTRAINT pk_expert_qualifications
  PRIMARY KEY (expert_id, qualification_id);

ALTER TABLE expert_qualifications
  ADD CONSTRAINT fk_eq_expert
  FOREIGN KEY (expert_id) REFERENCES experts(id)
  ON DELETE CASCADE;

ALTER TABLE expert_qualifications
  ADD CONSTRAINT fk_eq_qualification
  FOREIGN KEY (qualification_id) REFERENCES qualifications(id)
  ON DELETE CASCADE;

CREATE INDEX idx_eq_qualification ON expert_qualifications (qualification_id);
```

### 6.5 Why `@JoinTable` goes on exactly one side

If you put `@JoinTable` on both `Expert.qualifications` and `Qualification.experts`, TypeORM will silently create duplicate pivot metadata, and you'll see either an extra migration with strange column names or a runtime error so confusing you'll think your connection string is broken. Pick one side (the natural "first" entity — usually the one whose FK appears first in the pivot name) and never decorate the other.

### 6.6 Why the composite PK matters

Without `(expert_id, qualification_id)` as the primary key, you can insert duplicate `(1, 42)` rows. The DB will store them; nothing complains. Now your "is this expert qualified?" query returns two rows for the same answer; your count is wrong; your UI shows a duplicate. The composite PK is a one-line constraint that prevents an entire class of silent data corruption.

### 6.7 The promotion path (preview)

When business data creeps in — "we need `obtained_year` on `expert_qualifications`" — stop using `@JoinTable`. Promote the pivot to a real entity:

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
  obtainedYear!: number | null;
}
```

Now `Expert.qualifications` becomes `@OneToMany(() => ExpertQualification, eq => eq.expert)` and you do the same on `Qualification`. Two 1:Ns replace one M:N. Yes, more code. Yes, you'll need it.

Lesson 03 covers when to promote. Lesson 04 covers how to query through the promoted pivot efficiently.

### 6.8 Common M:N bugs

| Symptom                                                          | Cause                                                          | Fix                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------|------------------------------------------------------|
| Pivot table has duplicate `(expert, qualification)` rows         | Missing composite PK                                           | Add `(expert_id, qualification_id)` PK in migration   |
| `expert.qualifications` is `undefined`                           | Inverse side not declared on the other entity                  | Add `@ManyToMany(() => Expert, ...)` on Qualification |
| Migration creates pivot with wrong column names                  | `@JoinTable` declared on both sides                            | Strip from one side                                  |
| Can't add `obtained_year` later                                  | Implicit pivot doesn't allow columns                          | Promote to entity (recipe above)                     |
| Deleting an expert leaves dangling pivot rows                    | Missing `ON DELETE CASCADE` on the FK                          | Add it in a migration                                |

---

## 7. The owning-side table

This is the one mental shortcut that disambiguates every relationship. For every edge in the diagram, ask: **which table has the FK column?** That table is the owning side. The other table is the inverse.

| Edge                              | FK column lives on | Owning side | Inverse side |
|-----------------------------------|--------------------|-------------|--------------|
| `Users 1—1 Profiles`              | `profiles`         | `Profile`   | `User`       |
| `Users 1—1 Experts`               | `experts`          | `Expert`    | `User`       |
| `Users 1—N Posts`                 | `posts`            | `Post`      | `User`       |
| `Categories 1—N Experts`          | `experts`          | `Expert`    | `Category`   |
| `Experts M—N Qualifications`      | `expert_qualifications` (pivot) | `Expert` (declares `@JoinTable`) | `Qualification` |

Memorize this rule. When you're staring at the diagram and don't know which decorator goes where, look at the FK column. The arrow head in drawio is decoration; the FK column is the source of truth.

---

## 8. Decision points

### 8.1 When to make a FK `nullable`

- **`nullable: false`** — every child MUST have a parent. `Experts.category_id`, `Posts.user_id`. If you try to insert an expert without a category, the DB refuses.
- **`nullable: true`** — the child can exist without a parent. `Categories.parent_id` (top-level categories have no parent), `Experts.user_id` (a future admin-created expert might not be a user yet).

Decide **upfront** for every FK. The default (`nullable: true`) is rarely what you want.

### 8.2 When to put `@JoinColumn` on a 1:N

**Always on the `@ManyToOne` side. Never on the `@OneToMany` side.** This is not a choice; it's how TypeORM works. The "many" side owns the FK column; the FK column is declared by `@JoinColumn` on the side that owns it.

### 8.3 When to put `@JoinTable` on M:N

**Exactly one side.** Pick the entity whose FK is the first column in the pivot table. For `expert_qualifications(expert_id, qualification_id)`, that is `Expert`. For a pivot named `user_channels(user_id, channel_id)`, that is `User`. Document the choice in a one-line comment above the decorator — six months from now you'll forget.

### 8.4 When to promote a pivot to an entity

The moment you want to store anything other than `(a_id, b_id)` on the row. The candidates:

- `obtained_year`, `verified_at`, `score` on qualifications
- `level` ('native' | 'conversational') on languages
- `started_at`, `ended_at` on organizations

Don't wait. Promote early; the migration is cheap.

---

## 9. The cardinality cheat-sheet

Print this. Tape it to your monitor. Every time you add an entity, you walk through this:

| drawio edge                                  | TypeORM pair                                  | FK column                  |
|----------------------------------------------|-----------------------------------------------|----------------------------|
| `A 1—1 B` (A holds FK)                       | `@OneToOne` + `@OneToOne` + `@JoinColumn`     | on `B`                     |
| `A 1—N B`                                    | `@OneToMany` on `A` + `@ManyToOne`+`@JoinColumn` on `B` | on `B`             |
| `A M—N B`                                    | `@ManyToMany` + `@JoinTable` on **one** side, `@ManyToMany` on the other | new pivot table    |

That's the entire vocabulary. Three rows. Everything else is a variant or an exception.

---

## 10. Worked example — trace one edge end-to-end

Take `Experts ↔ Qualifications` from `er-2.drawio`.

**Step 1.** Look at the diagram. The edge label says "M—N". The pivot table is named `expert_qualifications`.

**Step 2.** Look at the pivot's columns: `expert_id`, `qualification_id`. Two FKs.

**Step 3.** Decide the owning side. The first column is `expert_id`, so `Expert` declares `@JoinTable`. `Qualification` declares only `@ManyToMany`.

**Step 4.** Write the code:

```ts
// expert.entity.ts
@ManyToMany(() => Qualification, (q) => q.experts, { cascade: true })
@JoinTable({
  name: 'expert_qualifications',
  joinColumn: { name: 'expert_id', referencedColumnName: 'id' },
  inverseJoinColumn: { name: 'qualification_id', referencedColumnName: 'id' },
})
qualifications!: Qualification[];
```

```ts
// qualification.entity.ts
@ManyToMany(() => Expert, (e) => e.qualifications)
experts!: Expert[];
```

**Step 5.** Write the migration: composite PK, FKs with `ON DELETE CASCADE`, the secondary index.

**Step 6.** Test: create a category, a qualification, an expert. Call `expert.qualifications` after `findOne({ where: { id }, relations: ['qualifications'] })`. Verify the array has the qualification.

**Step 7.** `EXPLAIN ANALYZE` the equivalent raw query. Confirm an index scan, not a sequential scan.

That's the entire workflow for any edge in the diagram.

---

## 11. Common mistakes (read this before you start coding)

1. **Decorating only one side of a relationship.** `@OneToMany` without `@ManyToOne`, or vice versa. Always both.
2. **Putting `@JoinColumn` on the inverse side.** The inverse side never gets `@JoinColumn`. Period.
3. **Putting `@JoinTable` on both sides of an M:N.** Pick one. Document the choice.
4. **Forgetting `unique: true` on a 1:1 FK.** Allows duplicates; corrupts the model.
5. **Forgetting the composite PK on a pivot.** Allows duplicate rows; corrupts counts.
6. **Using `cascade: true` (TypeORM) when you mean `onDelete: 'CASCADE'` (Postgres).** They serve different purposes. `cascade: true` is for "save children when I save parent". `onDelete` is for "wipe children when parent dies". Often you want exactly one; rarely both.
7. **Storing business data on the implicit pivot.** Promote to entity.
8. **Trusting the diagram's arrow head.** The arrow is decoration. The FK column is the truth.
9. **Marking inverse sides as `!` instead of `?`.** Inverse sides are `undefined` until you load them. Mark them optional.
10. **Skipping the smoke test.** After writing the relationship, do `findOne({ relations: [...] })` and assert the array is correct. If you skip this, the bug will ship.

---

## 12. Self-check

Answer these in writing before moving to Lesson 03.

1. What does it mean for a side to "own" a relationship? How do you identify it from the diagram?
2. Why does `@JoinColumn` appear on exactly one side, and how do you decide which?
3. For `Users 1—N Posts`, write the two entity stubs (just the relationship decorators and the relevant columns).
4. For `Experts M—N Languages` with a pivot `expert_languages`, write the two entity stubs and the SQL for the composite PK + both FKs.
5. Why is the implicit `@JoinTable` pivot a bad place to store `obtained_year`? What do you do instead?
6. State the composite-PK rule for any pivot, and explain what goes wrong if you skip it.
7. Look at `er-2.drawio`. List every 1:1, every 1:N, and every M:N edge.
8. Why is `cascade: true` not a substitute for `onDelete: 'CASCADE'`?
9. If you see `duplicate key value violates unique constraint` on `profiles_user_id_key`, what is the missing decorator option?
10. If you see `expert.qualifications` return `undefined` in production but the row exists in the DB, list the two most likely causes.

When you can answer all ten without re-opening this file, go to **Lesson 03**.
