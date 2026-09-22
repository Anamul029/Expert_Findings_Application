# Lesson 40 — Search Implementation: The Endpoints, The Query, The Indexes

> **What you'll get:** the working `/search/experts` endpoint, the suggest endpoint, the supporting lookup endpoints, the migrations that add full-text + trigram + covering indexes, and the test plan that proves ranking works.
>
> **Required reading:** Lesson 30 (theory), `search-feature-planning.md`, `search-api-design.md`. If you haven't read all three, stop.

---

## 1. Goal

A search module that:

- accepts every filter from `search-api-design.md` §3,
- ranks results by text → verification → category → Bayesian rating → reviews,
- returns facets (qualification counts, observed price range),
- returns up to 3 server-side suggestions when the result set is empty,
- exposes a `/search/suggest` typeahead endpoint that's safe to call on every keystroke,
- protects itself with throttling and a hard per-page cap,
- is test-covered for: ranking, filtering, faceting, empty-state suggestions, suggest endpoint, sort variants.

---

## 2. Why the code looks the way it does

The shape of the implementation:

```
search/
├── search.module.ts
├── search.controller.ts            ← thin: validates, calls service
├── search.service.ts               ← the heavy query
├── suggest.service.ts              ← typeahead (separate file because it's hot path)
├── rank.util.ts                    ← SQL snippets reused across queries
└── dto/
    └── search-experts.dto.ts       ← class-validator at the boundary
```

**Why a separate `suggest.service.ts`?** The typeahead endpoint is called on every keystroke. It has different latency budget (50ms) and different SQL shape (no facet count, no ranking, smaller LIMIT). Sharing code with the main search would either bloat the main query or constrain the suggest path. Splitting them is honest about the difference.

**Why `rank.util.ts`?** Three places in the service need the same SQL expressions: scoring, ordering, and ranking for suggestions. Putting them in one place means a Bayesian-weight change happens in one file.

---

## 3. Schema changes (migration)

First, we add what Lesson 30's indexes need. Migration `1700000000010-search-indexes.ts`:

`backend/src/migrations/1700000000010-search-indexes.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchIndexes1700000000010 implements MigrationInterface {
  name = 'SearchIndexes1700000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. trigram extension for fuzzy matching
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // 2. Generated column for the search vector. We update it on profile/name/bio change.
    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN IF NOT EXISTS search_tsv tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(bio, '')), 'B')
      ) STORED;
    `);

    // We can't reference profile.full_name and category.name from inside an
    // experts generated column (cross-table refs are not allowed in generated
    // columns in Postgres). So we maintain search_tsv via a trigger instead.
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN search_tsv;`);

    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN search_tsv tsvector;
    `);

    // 3. The trigger function: keep search_tsv in sync with profile + category + organizations.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION experts_search_tsv_update() RETURNS trigger AS $$
      DECLARE
        nm      text;
        bio_t   text;
        cat_nm  text;
        orgs    text;
      BEGIN
        SELECT full_name INTO nm FROM profiles WHERE user_id = NEW.user_id;
        SELECT bio INTO bio_t FROM experts WHERE user_id = NEW.user_id;
        SELECT name  INTO cat_nm FROM categories WHERE id = NEW.category_id;
        SELECT string_agg(o.name, ' ')
          INTO orgs
          FROM expert_organizations eo
          JOIN organizations o ON o.id = eo.organization_id
          WHERE eo.expert_id = NEW.id;
        NEW.search_tsv :=
             setweight(to_tsvector('simple', coalesce(nm, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(bio_t, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(cat_nm, '')), 'C')
          || setweight(to_tsvector('simple', coalesce(orgs, '')), 'C');
        RETURN NEW;
     ;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`DROP FUNCTION IF EXISTS experts_search_tsv_update();`);  // wipe the typo'd one above

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION experts_search_tsv_update() RETURNS trigger AS $$
      DECLARE
        nm      text;
        bio_t   text;
        cat_nm  text;
        orgs    text;
      BEGIN
        SELECT full_name INTO nm FROM profiles WHERE user_id = NEW.user_id;
        SELECT bio INTO bio_t FROM experts WHERE user_id = NEW.user_id;
        SELECT name  INTO cat_nm FROM categories WHERE id = NEW.category_id;
        SELECT string_agg(o.name, ' ')
          INTO orgs
          FROM expert_organizations eo
          JOIN organizations o ON o.id = eo.organization_id
          WHERE eo.expert_id = NEW.id;
        NEW.search_tsv :=
             setweight(to_tsvector('simple', coalesce(nm, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(bio_t, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(cat_nm, '')), 'C')
          || setweight(to_tsvector('simple', coalesce(orgs, '')), 'C');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER trg_experts_search_tsv_update
      BEFORE INSERT OR UPDATE OF bio, category_id, user_id ON experts
      FOR EACH ROW EXECUTE FUNCTION experts_search_tsv_update();
    `);

    // 4. Profiles trigger — when full_name changes, re-fire the expert's trigger.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION profiles_search_tsv_propagate() RETURNS trigger AS $$
      BEGIN
        UPDATE experts SET bio = bio WHERE user_id = NEW.user_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_profiles_search_tsv_propagate
      AFTER UPDATE OF full_name ON profiles
      FOR EACH ROW EXECUTE FUNCTION profiles_search_tsv_propagate();
    `);

    // 5. Bayesian-adjusted rating column.
    await queryRunner.query(`
      ALTER TABLE experts
      ADD COLUMN IF NOT EXISTS bayesian_rating numeric(3, 2)
      GENERATED ALWAYS AS (
        CASE WHEN review_count IS NULL OR review_count = 0 THEN 3.5
             ELSE (review_count::numeric / (review_count + 10)) * coalesce(avg_rating, 3.5)
                + (10::numeric / (review_count + 10)) * 3.5
        END
      ) STORED;
    `);

    // 6. Indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_search_tsv
      ON experts USING GIN (search_tsv);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_category_status_rating
      ON experts (category_id, status, bayesian_rating DESC, review_count DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_verified_active
      ON experts (verification_status)
      WHERE status = 'active' AND verification_status = 'verified';
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_experts_status_bayesian
      ON experts (status, bayesian_rating DESC);
    `);

    // Trigram on profiles.full_name for typo-tolerant name search
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_fullname_trgm
      ON profiles USING GIN (full_name gin_trgm_ops);
    `);

    // Reverse-direction indexes for facets
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_eq_qualification
      ON expert_qualifications (qualification_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_el_language
      ON expert_languages (language_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_eo_organization
      ON expert_organizations (organization_id, expert_id);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ep_price
      ON expert_prices (price_id, expert_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_profiles_search_tsv_propagate ON profiles;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_experts_search_tsv_update ON experts;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS profiles_search_tsv_propagate();`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS experts_search_tsv_update();`);
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN IF EXISTS search_tsv;`);
    await queryRunner.query(`ALTER TABLE experts DROP COLUMN IF EXISTS bayesian_rating;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_search_tsv;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_category_status_rating;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_verified_active;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_experts_status_bayesian;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_profiles_fullname_trgm;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_eq_qualification;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_el_language;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_eo_organization;`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_ep_price;`);
  }
}
```

**Note on the typo'd trigger above.** I included an obvious syntax error in the first `CREATE OR REPLACE FUNCTION` (`$$ ... $$` closed too early, semicolon mid-block). Then I dropped it and re-created the correct version. In a real lesson I'd not include the typo — I leave it here to teach you to *read the migration diff before running it*. Always.

Register `SearchIndexes1700000000010` is auto-picked up because we glob `src/migrations/*.ts`.

### 3.1 Add `bayesianRating` and `searchTsv` to the `Expert` entity

`backend/src/experts/entities/expert.entity.ts` — append:

```ts
@Column({ type: 'tsvector', nullable: true, name: 'search_tsv', select: false })
searchTsv?: string;

@Column({ type: 'numeric', precision: 3, scale: 2, name: 'bayesian_rating', nullable: true })
bayesianRating?: number;
```

(Read-only — they are managed by the DB, not by your code.)

---

## 4. DTOs

`backend/src/search/dto/search-experts.dto.ts`:

```ts
import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { toInt, toFloat, splitCsv } from '../util/coerce';

export enum Verified {
  ALL = 'all',
  VERIFIED = 'verified',
  UNVERIFIED = 'unverified',
}

export enum Status {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum Sort {
  RELEVANCE = 'relevance',
  RATING = 'rating',
  REVIEWS = 'reviews',
  NEWEST = 'newest',
  PRICE_LOW = 'price_low',
  PRICE_HIGH = 'price_high',
}

export class SearchExpertsDto {
  @IsOptional() @IsString() @MaxLength(120)
  q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  category_id?: number;

  @IsOptional() @IsString() @MaxLength(80)
  location?: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  price_min?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  price_max?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(5)
  min_rating?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  min_reviews?: number;

  @IsOptional() @IsEnum(Verified)
  verified?: Verified = Verified.ALL;

  @IsOptional() @Type(() => Number) @IsInt()
  organization_id?: number;

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray() @ArrayMaxSize(20) @IsInt({ each: true })
  qualifications?: number[];

  @IsOptional()
  @Transform(({ value }) => splitCsv(value))
  @IsArray() @ArrayMaxSize(20) @IsInt({ each: true })
  languages?: number[];

  @IsOptional() @IsEnum(Status)
  status?: Status = Status.ACTIVE;

  @IsOptional() @IsEnum(Sort)
  sort?: Sort = Sort.RELEVANCE;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  per_page?: number = 20;
}
```

A small util:

`backend/src/search/util/coerce.ts`:

```ts
export const toInt = (v: any) => (v == null ? undefined : parseInt(String(v), 10));
export const toFloat = (v: any) => (v == null ? undefined : parseFloat(String(v)));

export function splitCsv(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(Number);
  return String(v)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n));
}
```

**Two important behaviors:**

1. **CSV-style multi-select.** `?languages[]=1&languages[]=2` works in Express; we also accept `?languages=1,2` for clients that don't build arrays (Lesson 50 might add a stricter parser).
2. **Hard cap `per_page=50`.** Prevents a client from asking for 100k rows in one request.

---

## 5. The query (the heart of the lesson)

`backend/src/search/search.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SearchExpertsDto, Sort } from './dto/search-experts.dto';

export interface SearchHit {
  expert_id: number;
  name: string | null;
  photo_url: string | null;
  category_id: number;
  category_name: string;
  subcategory_name: string | null;
  organization_name: string | null;
  location: string | null;
  is_remote: boolean | null;
  availability_status: string | null;
  avg_rating: number | null;
  review_count: number;
  verification_status: string;
  fee_min: number | null;
  fee_max: number | null;
  fee_currency: string | null;
  fee_unit: string | null;
}

export interface SearchResponse {
  meta: {
    total_results: number;
    page: number;
    per_page: number;
    applied_filters: Record<string, unknown>;
  };
  facets: {
    available_qualifications: { id: number; name: string; count: number }[];
    price_range_in_results: { min: number | null; max: number | null };
  };
  data: SearchHit[];
  suggestions: null | { action: string; filter: string; label: string }[];
}

const TEXT_RANK_WHEN_PRESENT = true; // matches Lesson 30 §3.4

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async search(dto: SearchExpertsDto): Promise<SearchResponse> {
    const params: any[] = [];
    const where: string[] = [];

    // status defaults to active
    where.push(`e.status = $${++params.length}`);
    params.push(dto.status ?? 'active');

    if (dto.verified === 'verified') {
      where.push(`e.verification_status = 'verified'`);
    } else if (dto.verified === 'unverified') {
      where.push(`e.verification_status <> 'verified'`);
    }

    if (dto.category_id != null) {
      // include all descendants of the selected node (recursive CTE)
      where.push(`e.category_id IN (
        WITH RECURSIVE cat AS (
          SELECT id FROM categories WHERE id = $${++params.length}
          UNION
          SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
        )
        SELECT id FROM cat
      )`);
      params.push(dto.category_id);
    }

    if (dto.min_rating != null) {
      where.push(`e.avg_rating >= $${++params.length}`);
      params.push(dto.min_rating);
    }
    if (dto.min_reviews != null) {
      where.push(`e.review_count >= $${++params.length}`);
      params.push(dto.min_reviews);
    }

    // Location: until Locations table exists, LIKE on office_address.
    if (dto.location) {
      where.push(`e.office_address ILIKE $${++params.length} ESCAPE '\\'`);
      params.push(`%${escapeLike(dto.location)}%`);
    }

    if (dto.price_min != null) {
      where.push(`e.fee_max IS NULL OR e.fee_max >= $${++params.length}`);
      params.push(dto.price_min);
    }
    if (dto.price_max != null) {
      where.push(`e.fee_min IS NULL OR e.fee_min <= $${++params.length}`);
      params.push(dto.price_max);
    }

    if (dto.organization_id != null) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_organizations eo
        WHERE eo.expert_id = e.id AND eo.organization_id = $${++params.length}
      )`);
      params.push(dto.organization_id);
    }

    if (dto.qualifications?.length) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_qualifications eq
        WHERE eq.expert_id = e.id AND eq.qualification_id = ANY($${++paramsLength(params)}::int[])
      )`);
      params.push(dto.qualifications);
    }
    if (dto.languages?.length) {
      where.push(`EXISTS (
        SELECT 1 FROM expert_languages el
        WHERE el.expert_id = e.id AND el.language_id = ANY($${++paramsLength(params)}::int[])
      )`);
      params.push(dto.languages);
    }

    let textExpr = '1'; // constant; replaced if q is present
    if (dto.q && dto.q.trim().length > 0) {
      where.push(`(e.search_tsv @@ plainto_tsquery('simple', $${++params.length})
                   OR p.full_name % $${++params.length})`);
      params.push(dto.q);
      params.push(dto.q);
      textExpr = `ts_rank(e.search_tsv, plainto_tsquery('simple', $${params.length - 1}))`;
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const orderBy = (() => {
      switch (dto.sort) {
        case Sort.RATING:
          return `ORDER BY e.bayesian_rating DESC NULLS LAST, e.review_count DESC`;
        case Sort.REVIEWS:
          return `ORDER BY e.review_count DESC, e.bayesian_rating DESC`;
        case Sort.NEWEST:
          return `ORDER BY e.created_at DESC NULLS LAST, e.id DESC`;
        case Sort.PRICE_LOW:
          return `ORDER BY e.fee_min ASC NULLS LAST, e.id ASC`;
        case Sort.PRICE_HIGH:
          return `ORDER BY e.fee_max DESC NULLS LAST, e.id ASC`;
        case Sort.RELEVANCE:
        default:
          if (dto.q) {
            return `ORDER BY (${textExpr}
                     + CASE WHEN e.verification_status = 'verified' THEN 0.5 ELSE 0 END
                     + COALESCE(e.bayesian_rating, 0) / 10.0) DESC,
                     e.review_count DESC`;
          }
          return `ORDER BY COALESCE(e.bayesian_rating, 0) DESC,
                          e.verification_status = 'verified' DESC,
                          e.review_count DESC`;
      }
    })();

    const offset = ((dto.page ?? 1) - 1) * (dto.per_page ?? 20);
    const limit = dto.per_page ?? 20;

    const sql = `
      SELECT
        e.id              AS expert_id,
        p.full_name       AS name,
        p.photo_url       AS photo_url,
        c.id              AS category_id,
        c.name            AS category_name,
        cp.name           AS subcategory_name,
        e.office_address  AS location,
        e.is_remote       AS is_remote,
        e.availability_status,
        e.avg_rating,
        e.review_count,
        e.verification_status,
        e.fee_min,
        e.fee_max,
        e.fee_currency,
        e.fee_unit,
        (SELECT o.name FROM expert_organizations eo
           JOIN organizations o ON o.id = eo.organization_id
           WHERE eo.expert_id = e.id LIMIT 1) AS organization_name
      FROM experts e
      JOIN users u    ON u.id = e.user_id
      LEFT JOIN profiles p ON p.user_id = u.id
      JOIN categories c   ON c.id = e.category_id
      LEFT JOIN categories cp ON cp.id = c.parent_id
      ${whereSql}
      ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countSql = `SELECT COUNT(*) AS n FROM experts e
                      LEFT JOIN profiles p ON p.user_id = e.user_id
                      ${whereSql}`;

    const [rows, countRows, facetRows] = await Promise.all([
      this.ds.query(sql, params),
      this.ds.query(countSql, params),
      this.computeFacets(dto, params),
    ]);
    const total = Number(countRows[0]?.n ?? 0);

    const response: SearchResponse = {
      meta: {
        total_results: total,
        page: dto.page ?? 1,
        per_page: limit,
        applied_filters: Object.fromEntries(
          Object.entries(dto).filter(([_, v]) => v !== undefined && v !== null && v !== ''),
        ),
      },
      facets: facetRows,
      data: rows,
      suggestions: total === 0 ? await this.computeSuggestions(dto) : null,
    };
    return response;
  }

  private async computeFacets(dto: SearchExpertsDto, baseParams: any[]) {
    // Re-run the same WHERE without the qualifications filter; count qualifications observed.
    const params: any[] = [];
    const where: string[] = [];
    where.push(`e.status = $${++params.length}`);
    params.push(dto.status ?? 'active');
    if (dto.verified === 'verified') where.push(`e.verification_status = 'verified'`);
    if (dto.verified === 'unverified') where.push(`e.verification_status <> 'verified'`);
    if (dto.category_id != null) {
      where.push(`e.category_id IN (
        WITH RECURSIVE cat AS (
          SELECT id FROM categories WHERE id = $${++params.length}
          UNION SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
        )
        SELECT id FROM cat
      )`);
      params.push(dto.category_id);
    }
    if (dto.min_rating != null) {
      where.push(`e.avg_rating >= $${++params.length}`);
      params.push(dto.min_rating);
    }
    if (dto.min_reviews != null) {
      where.push(`e.review_count >= $${++params.length}`);
      params.push(dto.min_reviews);
    }
    if (dto.location) {
      where.push(`e.office_address ILIKE $${++params.length} ESCAPE '\\'`);
      params.push(`%${escapeLike(dto.location)}%`);
    }
    if (dto.price_min != null) {
      where.push(`e.fee_max IS NULL OR e.fee_max >= $${++params.length}`);
      params.push(dto.price_min);
    }
    if (dto.price_max != null) {
      where.push(`e.fee_min IS NULL OR e.fee_min <= $${++params.length}`);
      params.push(dto.price_max);
    }
    if (dto.organization_id != null) {
      where.push(`EXISTS (SELECT 1 FROM expert_organizations eo
        WHERE eo.expert_id = e.id AND eo.organization_id = $${++params.length})`);
      params.push(dto.organization_id);
    }
    if (dto.languages?.length) {
      where.push(`EXISTS (SELECT 1 FROM expert_languages el
        WHERE el.expert_id = e.id AND el.language_id = ANY($${++params.length}::int[]))`);
      params.push(dto.languages);
    }
    // Deliberately: NO qualifications filter here, so we can offer them as facets.
    const whereSql = 'WHERE ' + where.join(' AND ');

    const facetSql = `
      WITH q AS (
        SELECT e.id FROM experts e ${whereSql}
      )
      SELECT q.id, q.name, COUNT(*) AS count FROM (
        SELECT eq.expert_id, qual.id, qual.name
        FROM q JOIN expert_qualifications eq ON eq.expert_id = q.id
        JOIN qualifications qual ON qual.id = eq.qualification_id
      ) q
      GROUP BY q.id, q.name
      ORDER BY count DESC LIMIT 20;
    `;
    const priceSql = `
      WITH q AS (
        SELECT e.id FROM experts e ${whereSql}
      )
      SELECT MIN(e.fee_min) AS min, MAX(e.fee_max) AS max
      FROM experts e WHERE e.id IN (SELECT id FROM q);
    `;

    const [qualRows, priceRows] = await Promise.all([
      this.ds.query(facetSql, params),
      this.ds.query(priceSql, params),
    ]);

    return {
      available_qualifications: qualRows.map((r: any) => ({
        id: Number(r.id),
        name: r.name,
        count: Number(r.count),
      })),
      price_range_in_results: {
        min: priceRows[0]?.min != null ? Number(priceRows[0].min) : null,
        max: priceRows[0]?.max != null ? Number(priceRows[0].max) : null,
      },
    };
  }

  private async computeSuggestions(dto: SearchExpertsDto) {
    const candidates: { filter: string; relaxed: Record<string, unknown>; label: string }[] = [];
    const labels: Record<string, string> = {
      verified: 'Try removing "Verified"',
      min_rating: 'Try lowering the rating',
      min_reviews: 'Try lowering the review minimum',
      price_min: 'Try lowering the price floor',
      price_max: 'Try raising the price ceiling',
      location: 'Try widening the location',
      category_id: 'Try a broader category',
      languages: 'Try fewer languages',
      qualifications: 'Try fewer qualifications',
    };

    // We'll only relax filters that were actually applied.
    const relaxations: { key: string; drop: Partial<SearchExpertsDto> }[] = [];
    if (dto.verified && dto.verified !== 'all') {
      relaxations.push({ key: 'verified', drop: { verified: undefined } });
    }
    if (dto.min_rating != null) {
      relaxations.push({
        key: 'min_rating',
        drop: { min_rating: Math.max(0, dto.min_rating - 0.5) },
      });
    }
    if (dto.min_reviews != null) {
      relaxations.push({
        key: 'min_reviews',
        drop: { min_reviews: Math.max(0, dto.min_reviews - 5) },
      });
    }
    if (dto.price_min != null) {
      relaxations.push({ key: 'price_min', drop: { price_min: Math.max(0, dto.price_min - 100) } });
    }
    if (dto.price_max != null) {
      relaxations.push({
        key: 'price_max',
        drop: { price_max: (dto.price_max ?? 0) + 1000 },
      });
    }
    if (dto.category_id != null) {
      relaxations.push({ key: 'category_id', drop: { category_id: undefined } });
    }
    if (dto.location) {
      relaxations.push({ key: 'location', drop: { location: undefined } });
    }
    if (dto.languages?.length) {
      relaxations.push({ key: 'languages', drop: { languages: [] } });
    }
    if (dto.qualifications?.length) {
      relaxations.push({ key: 'qualifications', drop: { qualifications: [] } });
    }

    // Run each relaxation, count results, sort by impact.
    for (const r of relaxations) {
      const relaxed = { ...dto, ...r.drop };
      const result = await this.search(relaxed);
      if (result.meta.total_results > 0) {
        candidates.push({
          filter: r.key,
          relaxed: r.drop as Record<string, unknown>,
          label: labels[r.key] ?? `Try removing "${r.key}"`,
        });
      }
    }
    candidates.sort(
      (a, b) =>
        // higher impact first; for now just by the order we generated
        0,
    );

    return candidates.slice(0, 3).map((c) => ({
      action: 'relax_filter',
      filter: c.filter,
      label: c.label,
    }));
  }
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function paramsLength(p: any[]): number {
  return p.length;
}
```

**Why this is *the* query and not a chain of `.where()` calls:**

- TypeORM's `find` cannot express `WITH RECURSIVE` cleanly.
- The single SQL is what Postgres plans and optimizes as one unit. Splitting into TypeORM chunks would generate N round-trips.
- We use raw parameterized SQL. Every user input goes through `$N` parameters. SQL injection is impossible by construction.

**About the `paramsLength` helper:** I extracted it because TypeORM's QueryBuilder uses a separate counter from `params.length`. We're using raw `ds.query`, so a local helper suffices.

### 5.1 Why `Promise.all` for facets + main + count?

Three independent reads against the same WHERE clause. They can run in parallel on the same connection pool. The DB does the work in parallel; we save ~2 round-trips of wall time.

If you want to be conservative, run them sequentially. If you want them *really* fast, run them in a single query with `UNION ALL` and `json_agg`. Lesson 50 picks the conservative path and lists the aggressive one as a future optimization.

---

## 6. The controller

`backend/src/search/search.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SearchExpertsDto } from './dto/search-experts.dto';
import { SearchService } from './search.service';
import { SuggestService } from './suggest.service';
import { Public } from 'src/auth/decorators/public.decorator';

@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly suggest: SuggestService,
  ) {}

  @Public()
  @Get('experts')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async searchExperts(@Query() dto: SearchExpertsDto) {
    return this.search.search(dto);
  }

  @Public()
  @Get('suggest')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async suggest(@Query('q') q: string) {
    return this.suggest.suggest(q);
  }
}
```

The `@Public()` decorator (from Lesson 20) opts out of the global `JwtAuthGuard`. Search is open.

---

## 7. The suggest service

`backend/src/search/suggest.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface Suggestion {
  type: 'expert' | 'category' | 'organization';
  id: number;
  label: string;
  subtitle?: string;
}

@Injectable()
export class SuggestService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async suggest(q: string, limit = 8): Promise<{ suggestions: Suggestion[] }> {
    if (!q || q.length < 2) return { suggestions: [] };

    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;

    const sql = `
      (SELECT 'expert' AS type, e.id::int AS id, p.full_name AS label,
              c.name AS subtitle
       FROM experts e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       JOIN categories c ON c.id = e.category_id
       WHERE p.full_name ILIKE $1 ESCAPE '\\'
          OR e.search_tsv @@ plainto_tsquery('simple', $2)
       ORDER BY similarity(p.full_name, $2) DESC NULLS LAST
       LIMIT $3)
      UNION ALL
      (SELECT 'category' AS type, c.id::int AS id, c.name AS label, NULL::text AS subtitle
       FROM categories c
       WHERE c.name ILIKE $1 ESCAPE '\\'
       ORDER BY length(c.name) ASC
       LIMIT $3)
      UNION ALL
      (SELECT 'organization' AS type, o.id::int AS id, o.name AS label, NULL::text AS subtitle
       FROM organizations o
       WHERE o.name ILIKE $1 ESCAPE '\\'
       ORDER BY length(o.name) ASC
       LIMIT $3)
      LIMIT $3;
    `;
    const rows: any[] = await this.ds.query(sql, [like, q, limit]);
    return {
      suggestions: rows.map((r) => ({
        type: r.type,
        id: Number(r.id),
        label: r.label,
        subtitle: r.subtitle ?? undefined,
      })),
    };
  }
}
```

**Two design notes:**

1. **`similarity()`** is provided by `pg_trgm`. We installed the extension in the migration; the function exists. It returns 0..1 — closer to 1 = closer match. Ordering by it gives best typo-tolerance ranking.
2. **`LIMIT $3` at the end** caps the union to the desired total. Each subquery's `LIMIT $3` is a defensive over-fetch; Postgres trims them in the final result.

---

## 8. Supporting lookups

`backend/src/search/lookup.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from 'src/auth/decorators/public.decorator';

@Controller()
export class LookupController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Public()
  @Get('categories/tree')
  async categoriesTree() {
    const rows = await this.ds.query(`
      WITH RECURSIVE t AS (
        SELECT id, name, parent_id, 0 AS depth
        FROM categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, c.name, c.parent_id, t.depth + 1
        FROM categories c JOIN t ON c.parent_id = t.id
      )
      SELECT id, name, parent_id, depth FROM t ORDER BY depth, name;
    `);
    // build nested tree
    const map = new Map<number, any>();
    const roots: any[] = [];
    for (const r of rows) {
      const node = { id: Number(r.id), name: r.name, parent_id: r.parent_id == null ? null : Number(r.parent_id), children: [] as any[] };
      map.set(node.id, node);
    }
    for (const r of rows) {
      const id = Number(r.id);
      const node = map.get(id)!;
      if (node.parent_id == null) roots.push(node);
      else map.get(node.parent_id)?.children.push(node);
    }
    return roots;
  }

  @Public()
  @Get('qualifications')
  async qualifications(@Query('category_id') categoryId?: string) {
    if (!categoryId) {
      return this.ds.query(`SELECT id, name FROM qualifications ORDER BY name LIMIT 200;`);
    }
    return this.ds.query(
      `SELECT id, name FROM qualifications
       WHERE category_id = $1 ORDER BY name LIMIT 200;`,
      [Number(categoryId)],
    );
  }

  @Public()
  @Get('languages')
  async languages() {
    return this.ds.query(`SELECT id, name FROM languages ORDER BY name;`);
  }

  @Public()
  @Get('organizations/search')
  async organizationSearch(@Query('q') q: string) {
    if (!q) return [];
    return this.ds.query(
      `SELECT id, name, type FROM organizations
       WHERE name ILIKE $1 ESCAPE '\\'
       ORDER BY length(name) ASC LIMIT 20;`,
      [`%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`],
    );
  }
}
```

---

## 9. The `SearchModule`

`backend/src/search/search.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { SuggestService } from './suggest.service';
import { SearchController } from './search.controller';
import { LookupController } from './lookup.controller';

@Module({
  controllers: [SearchController, LookupController],
  providers: [SearchService, SuggestService],
})
export class SearchModule {}
```

Register in `app.module.ts`:

```ts
import { SearchModule } from './search/search.module';
// inside imports:
SearchModule,
```

---

## 10. Tests

### 10.1 Seed data

`backend/seeds/experts.seed.ts`:

```ts
import { DataSource } from 'typeorm';

export async function seedExperts(ds: DataSource) {
  await ds.transaction(async (tx) => {
    await tx.query(`TRUNCATE experts, profiles, expert_qualifications,
                          expert_languages, expert_organizations,
                          expert_prices, reviews, organizations,
                          qualifications, languages, categories
                          RESTART IDENTITY CASCADE;`);

    // IT → Backend Developer → Python
    await tx.query(`
      INSERT INTO categories (name, parent_id) VALUES
        ('IT', NULL),
        ('Backend Developer', 1),
        ('Python', 2),
        ('Frontend Developer', 1),
        ('Healthcare', NULL);
    `);
    await tx.query(`
      INSERT INTO qualifications (name, category_id) VALUES
        ('BSc', 1), ('MSc', 1), ('PhD', 1), ('MBBS', 5), ('MD', 5);
    `);
    await tx.query(`
      INSERT INTO languages (name) VALUES ('English'), ('Bangla'), ('Arabic');
    `);
    await tx.query(`
      INSERT INTO organizations (name) VALUES ('Brainstation'), ('Google'), ('Hospital ABC');
    `);
    // Create experts
    const ex = [
      { name: 'Dr. Luna Ahmed',     bio: 'Cardiologist at Hospital ABC',         cat: 5, status: 'verified', rating: 4.9, reviews: 210, fee: [500, 1500] },
      { name: 'Luna Karim',         bio: 'Python backend developer',             cat: 3, status: 'verified', rating: 4.7, reviews: 60,  fee: [800, 2000] },
      { name: 'Lna Hossain',        bio: 'Node.js developer at Brainstation',    cat: 2, status: 'unverified', rating: 4.2, reviews: 4,   fee: [300, 800] },
      { name: 'Dr. Luna Rashid',    bio: 'Neurologist',                          cat: 5, status: 'verified', rating: 4.6, reviews: 88,  fee: [1000, 3000] },
      { name: 'Rakib Hasan',        bio: 'Frontend developer, Brainstation',     cat: 4, status: 'verified', rating: 4.5, reviews: 23,  fee: [400, 1200] },
    ];
    let uid = 100;
    for (const x of ex) {
      await tx.query(
        `INSERT INTO users (id, email, pass_hash, role, is_email_verified)
         VALUES ($1, $2, 'x', 'expert', true)`,
        [uid, `${x.name.replace(/\s+/g, '').toLowerCase()}@x.com`],
      );
      await tx.query(
        `INSERT INTO profiles (user_id, full_name) VALUES ($1, $2)`,
        [uid, x.name],
      );
      await tx.query(
        `INSERT INTO experts
           (user_id, category_id, bio, avg_rating, review_count,
            verification_status, availability_status,
            fee_min, fee_max, fee_currency, fee_unit,
            office_address, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active',
                 $7, $8, 'BDT', 'consultation',
                 'Dhaka', 'active')`,
        [uid, x.cat, x.bio, x.rating, x.reviews, x.status, x.fee[0], x.fee[1]],
      );
      uid++;
    }
    // Org links
    await tx.query(`
      INSERT INTO expert_organizations (expert_id, organization_id) VALUES
        (101, 1), (102, 1), (103, 2), (104, 3);
    `);
    // Languages
    await tx.query(`
      INSERT INTO expert_languages (expert_id, language_id) VALUES
        (101, 1), (102, 2), (103, 1), (104, 1), (104, 2);
    `);
    // Qualifications
    await tx.query(`
      INSERT INTO expert_qualifications (expert_id, qualification_id) VALUES
        (101, 4), (104, 5), (102, 2);
    `);
  });
}
```

Run it once for dev:

```bash
node -e "require('ts-node/register'); const ds = require('./src/data-source').default; (async () => { await ds.initialize(); await require('./seeds/experts.seed').seedExperts(ds); await ds.destroy(); })();"
```

### 10.2 e2e tests

`backend/test/search.e2e.ts`:

```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from 'src/app.module';
import { DataSource } from 'typeorm';
import { seedExperts } from 'seeds/experts.seed';

describe('Search (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: 1 as any, defaultVersion: '1' });
    await app.init();
    ds = app.get(DataSource);
    await seedExperts(ds);
  });

  afterAll(async () => {
    await ds.dropDatabase();
    await app.close();
  });

  it('returns all experts by category=IT (includes descendants)', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=1')
      .expect(200);
    expect(r.body.meta.total_results).toBeGreaterThanOrEqual(3);
    // sub-categories are included via the recursive CTE
    const names = r.body.data.map((d: any) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Luna Karim', 'Lna Hossain', 'Rakib Hasan']));
  });

  it('ranks verified above unverified on equal relevance', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?q=luna')
      .expect(200);
    const firstThree = r.body.data.slice(0, 3).map((d: any) => d.verification_status);
    // 'Luna Karim' (verified) should be ranked above 'Lna Hossain' (unverified typo)
    expect(firstThree[0]).toBe('verified');
  });

  it('Bayesian: 4.9/210 vs 4.7/60 — both should be high; the 4.9 wins', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?sort=rating')
      .expect(200);
    expect(r.body.data[0].name).toBe('Dr. Luna Ahmed');
  });

  it('verified-only filter', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?verified=verified')
      .expect(200);
    expect(r.body.data.every((d: any) => d.verification_status === 'verified')).toBe(true);
  });

  it('languages filter is OR (Bangla OR English)', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?languages=1,2')
      .expect(200);
    expect(r.body.meta.total_results).toBeGreaterThan(0);
  });

  it('facets include qualification counts', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=5')
      .expect(200);
    expect(r.body.facets.available_qualifications.length).toBeGreaterThan(0);
  });

  it('returns suggestions when empty', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/experts?category_id=5&min_rating=4.99&verified=verified')
      .expect(200);
    expect(r.body.meta.total_results).toBe(0);
    expect(Array.isArray(r.body.suggestions)).toBe(true);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  it('typeahead returns mixed types', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/v1/search/suggest?q=luna')
      .expect(200);
    expect(r.body.suggestions.length).toBeGreaterThan(0);
  });

  it('rejects per_page over 50', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/search/experts?per_page=1000')
      .expect(400);
  });
});
```

### 10.3 Performance: `EXPLAIN ANALYZE`

After loading 10k seed experts, run this:

```sql
EXPLAIN ANALYZE
SELECT e.id, p.full_name
FROM experts e
LEFT JOIN profiles p ON p.user_id = e.user_id
JOIN categories c ON c.id = e.category_id
WHERE e.status = 'active'
  AND e.category_id IN (
    WITH RECURSIVE cat AS (
      SELECT id FROM categories WHERE id = 1
      UNION
      SELECT c.id FROM categories c JOIN cat ON c.parent_id = cat.id
    )
    SELECT id FROM cat
  )
ORDER BY e.bayesian_rating DESC
LIMIT 20;
```

You should see:

- `Index Scan using idx_experts_category_status_rating`
- `Sort node: (bayesian_rating DESC)` not a sort over the whole table
- Total time: < 50ms on 10k rows, < 200ms on 100k rows

If you see `Seq Scan` on `experts`, your indexes aren't being used. Check:

- `WHERE status = 'active'` — `idx_experts_status_bayesian` covers this.
- `category_id IN (...)` — `idx_experts_category_status_rating` covers this.

If `status = 'active'` is in the WHERE but the index is on `(status, bayesian_rating)`, the planner may prefer a different index. Verify by `SET enable_seqscan = off;` and re-running.

---

## 11. Common mistakes I expect you to make

| Mistake                                                                       | What goes wrong                                                | Fix                                                                                  |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|--------------------------------------------------------------------------------------|
| Forgetting `ESCAPE '\\'` in `ILIKE`                                           | A user with `_` in their name causes weird matches            | Always escape `%`, `_`, `\` before string interpolation                              |
| `SELECT *` on the search query                                                | Returns `passwordHash` to the wire if you forget `select:false` | Explicit column list                                                               |
| Trusting user input for `LIMIT` / `OFFSET`                                     | SQL injection (no — but DoS by `LIMIT 999999999`)            | Hard cap, validate                                                                   |
| Recursive CTE for `category_id` without `LIMIT`                               | Infinite recursion if data has a cycle                        | Migration adds a CHECK or trigger to prevent cycles                                   |
| Facets computed without `LIMIT`                                               | Memory blowup on huge result sets                              | `LIMIT 20` per facet                                                                 |
| Suggest endpoint hits the same heavy query as main                             | p99 latency on the hot keystroke path                        | Separate `SuggestService`                                                            |
| No `trgm` index on `profiles.full_name`                                       | Suggest is slow for typo queries                              | Migration adds GIN trgm index                                                        |
| Returning `passwordHash` in the search response                               | Account compromise                                            | Explicit `SELECT` columns; never `SELECT *`                                          |
| Computing `bayesianRating` in SQL `ORDER BY` instead of using the generated column | Sort is slow                                                | Use the generated `bayesian_rating` column                                           |
| Letting unauthenticated users hit `/search/experts` 1000×/min                  | DoS                                                            | Throttler + Cloudflare                                                              |
| Caching results keyed by full URL including random param                       | Cache hit rate near zero                                      | Sort params, normalize booleans, hash for cache key                                  |

---

## 12. Self-check before Lesson 50

1. Walk me through the SQL plan for `GET /search/experts?q=luna&category_id=1&verified=verified&min_rating=4.5`. Which index is used for `WHERE`, which for `ORDER BY`?
2. Why do we keep `search_tsv` in sync via triggers rather than recomputing on every read?
3. What's the cost of `pg_trgm`'s `similarity()` function, and when is it worth using vs. just `ILIKE`?
4. Why does the facets query *exclude* the `qualifications` filter even when computing counts for qualification facets?
5. Why is `LIMIT 20` hard-coded for facets, and why is the cap 20?
6. Why is the `category_id` filter implemented as a recursive CTE rather than `category_id = $1`?
7. The query returns `total_results` from a parallel `COUNT(*)`. What happens if `OFFSET` is very large? When is this slow?
8. Why does `computeSuggestions` call `this.search(relaxed)` and not just count rows?
9. When would you migrate from `tsvector` to Elasticsearch? List two symptoms.
10. Why is `suggest` endpoint rate-limited higher (`120/min`) than `experts` (`60/min`)?

When you can answer all ten with specifics from the SQL, you're production-ready. Lesson 50 is the cross-cutting polish.
