# Lesson 05 — Schema Foundation: Fix the Bones Before Building on Them

> **What you'll get:** a refactored `User` entity, a brand-new `Profile` entity, a redesigned `Otp` entity that supports resend and brute-force protection, Google OAuth fields, and migrations that replace `synchronize: true`. After this lesson, the foundation can carry Lessons 10 and 30 without surprises.
>
> **Why this lesson exists:** the current schema has three latent bugs — the `Otp` relation is `OneToOne` (a user can never resend), there is no `Profile` entity yet (where will the user's name and phone live?), and `synchronize: true` will silently drop columns when we rename them. We fix all three before we build auth on top.

---

## 1. Goal

By the end of this lesson:

- `User` is correct: roles, status, verified flag, Google linking, refresh-token hash.
- `Profile` is a 1:1 extension of `User` for non-auth PII (name, phone, photo, bio).
- `Otp` is a 1:N history of codes per user, with `purpose`, `expiresAt`, `attempts`, `lastSentAt`, and a hashed code column.
- All changes are in a **migration**, not auto-applied by TypeORM.
- `synchronize: false`. The dev DB is brought up by `migration:run`.
- `EXPLAIN` shows we have an index on `users(email)`, `otp(user_id, purpose, expires_at)`, `profiles(user_id)`.

---

## 2. Why this matters — the three latent bugs

### 2.1 `Otp` is `OneToOne` to `User`

**Current code** (`backend/src/otp/entities/otp.entity.ts`):

```ts
@OneToOne(() => User)
@JoinColumn({ name: 'user_id' })
user: User;
```

This means **one user can have at most one OTP row, ever**. Your spec says:

> "If he didn't received the OTP he can request for `resend OTP` but he will have to wait for 1 minute."

The resend flow needs to either (a) update the existing row's `expiresAt` and `oneTimeCode`, or (b) insert a new row and look at the most recent one. Option (b) is what every production system does, because it keeps an audit trail of how many OTPs were issued, when, and how many were tried. With `OneToOne`, you either lose history or you have to fake it with timestamps. We're picking the right model.

### 2.2 No `Profile` entity

Your `Expert Finding.md` says:

> "After successful login or registration the user will be redirected to `profile page`. where he will fill up or input his personal information."

We need somewhere to store name, phone, photo, address. Two options:

- **Put it all on `User`.** Fast to start, slow forever. Every PII column mixes with auth columns; password resets accidentally email the phone number; you can't `select: false` name without breaking the JWT.
- **1:1 extension.** `Users` = auth identity. `Profiles` = public PII. They can be `select`-ed, `delete`-d, and audited independently. This is what `er-2.drawio` says; we honor the diagram.

### 2.3 `synchronize: true`

Read the TypeORM docs in one paragraph: when `synchronize: true`, every time the app starts, TypeORM looks at your entities, compares to the DB schema, and runs `ALTER TABLE` to "fix" the differences. It sounds helpful. It is a **production incident waiting to happen**.

Real failure: you rename `Otp.oneTimeCode` to `Otp.codeHash`. On the next deploy, TypeORM drops the column with the data, then adds the new one. Every existing OTP is lost. Every user in mid-verification is locked out. You didn't even run a query.

Migrations are explicit, reviewable, replayable, and reversible. There is no world in which `synchronize: true` is acceptable on a long-lived DB. We turn it off today.

---

## 3. Concepts

### 3.1 The OTP model: history vs. single-row

A typical OTP table stores rows like:

```text
id | user_id | purpose      | code_hash           | expires_at         | attempts | last_sent_at
1  | 42      | VERIFICATION | $2a$10$abc...       | 2026-01-01 12:05   | 0        | 2026-01-01 12:00
2  | 42      | VERIFICATION | $2a$10$def...       | 2026-01-01 12:06   | 1        | 2026-01-01 12:01   ← resend
3  | 42      | PASS_RESET   | $2a$10$ghi...       | 2026-01-03 09:00   | 0        | 2026-01-03 08:55   ← different purpose
```

To find the "current OTP" for a user, you query:

```sql
SELECT * FROM otp
WHERE user_id = $1
  AND purpose = $2
  AND expires_at > now()
  AND used_at IS NULL
ORDER BY last_sent_at DESC
LIMIT 1;
```

The `code_hash` is `bcrypt(code, cost 10)`. **Do not store OTPs in cleartext.** If your DB leaks, attackers shouldn't get free tokens for active sessions.

### 3.2 The `Profile` model: 1:1 extension

The cardinal rule: `User` = "who can log in", `Profile` = "what they look like to other users". This separation lets you:

- `select: false` the password hash and never accidentally leak it in a `SELECT *`.
- Soft-delete a profile without deleting auth.
- Have multiple profiles later (personal + business) if your product evolves — without redesigning `User`.

The `User.profile` field is the inverse side; `Profile.user` is the owning side with `unique: true`. If you ever see "duplicate key value violates unique constraint" on `profiles_user_id_key`, a bug already let two profiles in. Add a unique index in the migration defensively.

### 3.3 Migration anatomy

A TypeORM migration is a class with `up` and `down`:

```ts
export class AddProfile1700000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(/* ... */);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable(/* ... */);
  }
}
```

The `down` method **must** undo `up`. If you can't write `down`, you have a non-reversible change — and you should think twice about doing it.

A migration is run with:

```bash
npm run migration:run
```

Reversed with:

```bash
npm run typeorm -- migration:revert -d src/data-source.ts
```

In CI we run `migration:run` before tests start, against an ephemeral Postgres. The `down` is only used in dev when you broke something.

### 3.4 Refresh tokens — quick aside (full details in Lesson 20)

To support refresh-token rotation, we need a place to store *hashed* refresh tokens. A common pattern: a `refresh_tokens` table with `(id, user_id, hash, expires_at, revoked_at, replaced_by)`. On every refresh we mint a new row, mark the old one `revoked_at`, set `replaced_by = new_id`. If a `revoked_at` token is ever presented again, we **revoke the entire chain** — this is reuse-detection, and it's how you respond to a stolen refresh token.

We don't need to build it yet, but we *do* need a slot in `User` for a refresh-token version counter (`tokenVersion`) so we can mass-logout a user without iterating their tokens.

---

## 4. Decision points

### 4.1 OTP code hashing: bcrypt or SHA-256?

- **bcrypt cost 10.** ~100ms per verify on modern hardware. Pros: you already use bcrypt for passwords; reuse expertise. Cons: 6-digit OTP has only 10⁶ possibilities; bcrypt's slow hash limits brute force even if DB is leaked.
- **HMAC-SHA256 with a server-side pepper.** Faster, but you lose bcrypt's natural slow-down.
- **Plain SHA-256.** Catastrophic. 6-digit codes can be brute-forced offline in seconds.

**We use bcrypt cost 10 for OTPs.** Consistent with passwords, brute-force-bounded.

### 4.2 `Otp.user` relation: `OneToMany` with a `latestOtp` getter, or a separate query?

- **`OneToMany` + explicit `findOne` in service.** What every production system does. Easy to reason about; service owns the "current OTP" rule.
- **A computed `latestOtp` column on `User`.** Faster, but a denormalization you have to keep in sync. We don't.

### 4.3 Where does the JWT secret live?

- **In env.** Standard. Must be 32+ random bytes; never re-used across environments.
- **In a secret manager.** (AWS Secrets Manager, Vault.) Better. Out of scope for this codebase, but Lesson 50 shows you the hook point.

### 4.4 `tokenVersion` vs deleting refresh tokens on logout

- **`tokenVersion` integer.** On logout, increment. All existing refresh tokens become invalid in O(1). Simple, fast.
- **Mark every refresh token revoked.** Slower; useful when you want a per-device logout.

We use **both**. `tokenVersion` for global logout; per-token revocation for "log out this device only".

---

## 5. Code (drop-in, in order)

### 5.1 New package dependencies

```bash
npm install bcrypt
npm install -D @types/bcrypt
```

We're using `bcrypt` (not `bcryptjs`) — the native build is faster, and you already have a Node environment that can compile it.

### 5.2 Update `tsconfig.json` (paths + strict)

Open `backend/tsconfig.json`. Confirm `strictNullChecks`, `noImplicitAny`, and `strict` are all on. Add:

```json
{
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "src/*": ["src/*"]
    }
  }
}
```

We'll use `src/...` imports everywhere for readability.

### 5.3 Replace `User` entity

`backend/src/user/entities/user.entity.ts`:

```ts
import { Expert } from 'src/experts/entities/expert.entity';
import { Otp } from 'src/otp/entities/otp.entity';
import { Profile } from 'src/profile/entities/profile.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserRole {
  CLIENT = 'client',
  EXPERT = 'expert',
  ADMIN = 'admin',
}

export enum UserStatus {
  ACTIVE = 'active',
  DEACTIVE = 'deactive',
  DELETED = 'deleted',
}

@Entity('users')
@Index('uq_users_email_lower', { synchronize: false }) // added in migration for case-insensitive unique
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  // We use citext on the column (added in migration) so equality is case-insensitive.
  @Column({ type: 'citext', unique: true })
  email: string;

  @Column({ type: 'varchar', name: 'pass_hash', select: false, nullable: true })
  passwordHash: string | null;

  // OAuth linking — null until the user goes through Google at least once.
  @Column({ type: 'varchar', name: 'google_id', nullable: true, unique: true })
  googleId: string | null;

  @Column({ type: 'citext', name: 'google_email', nullable: true })
  googleEmail: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CLIENT })
  role: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'boolean', name: 'is_email_verified', default: false })
  isEmailVerified: boolean;

  // Incremented on global logout (e.g. password reset, "log out all devices").
  @Column({ type: 'int', name: 'token_version', default: 1 })
  tokenVersion: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // ---------- relations ----------

  @OneToOne(() => Profile, (p) => p.user)
  profile?: Profile;

  @OneToOne(() => Expert, (e) => e.user)
  expert?: Expert;

  @OneToMany(() => Otp, (o) => o.user)
  otps?: Otp[];
}
```

**Decision notes for the entity above:**

- `email` is `citext`, not `varchar`. We'll enable the extension in the migration. Why? `"Foo@x.com"` and `"foo@x.com"` are the same address; case-insensitive uniqueness should live in the DB, not in the app.
- `passwordHash` is `nullable: true` because OAuth-only users have no password.
- `googleId` is `unique: true`. This enforces the invariant: "each Google account maps to at most one user". Without it, two users could share a Google login.
- `tokenVersion` is your global logout switch. Lesson 20 explains why.
- `isEmailVerified` is `boolean` not `tinyint`. Postgres booleans are fine.
- We don't put `name` or `phone` here — that's the `Profile`.

### 5.4 Create `Profile` entity

`backend/src/profile/entities/profile.entity.ts`:

```ts
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('profiles')
export class Profile {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('uq_profiles_user_id', { unique: true })
  @Column({ type: 'int', name: 'user_id', unique: true })
  userId: number;

  @OneToOne(() => User, (u) => u.profile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 80, nullable: true })
  fullName: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'photo_url' })
  photoUrl: string | null;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'date', nullable: true, name: 'date_of_birth' })
  dateOfBirth: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

**Why two declarations of `user_id`?**

I used both `@Index('uq_profiles_user_id', { unique: true })` on the column decorator *and* `@Column({ ..., unique: true })`. This is belt-and-braces. The `@Index` decorator adds an explicit named index (which we can also write in the migration), and the `unique: true` on the column tells TypeORM's metadata. In a perfect world you'd pick one — but in the world of TypeORM migrations, the redundancy survives renames better.

### 5.5 Rewrite `Otp` entity

`backend/src/otp/entities/otp.entity.ts`:

```ts
import { User } from 'src/user/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum OtpPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

@Entity('otp')
@Index('idx_otp_user_purpose_expires', ['user', 'purpose', 'expiresAt'])
export class Otp {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (u) => u.otps, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: OtpPurpose })
  purpose!: OtpPurpose;

  // bcrypt hash, never the cleartext code.
  @Column({ type: 'varchar', length: 80, name: 'code_hash', select: false })
  codeHash!: string;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 5, name: 'max_attempts' })
  maxAttempts!: number;

  @Column({ type: 'timestamp', nullable: true, name: 'used_at' })
  usedAt!: Date | null;

  @Column({ type: 'timestamp', name: 'last_sent_at' })
  lastSentAt!: Date;

  // IP that requested the OTP — useful for abuse signals. NOT for auth.
  @Column({ type: 'inet', nullable: true, name: 'request_ip' })
  requestIp!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

**Why these columns?**

- `codeHash` is `select: false`. If you ever `SELECT *` for debugging, you won't accidentally read or log the hash.
- `purpose` lets the same user have a verification OTP *and* a password-reset OTP in flight at once. We will *never* check one against the other.
- `attempts` and `maxAttempts` enforce the brute-force lockout. Increment before comparing; on `>= maxAttempts` mark `usedAt` and refuse.
- `lastSentAt` powers the 60-second resend cooldown.
- `requestIp` is informational. If the same IP requests 100 OTPs for 100 different emails, your mail service is being abused; you'll see it here.

### 5.6 Create the `Profile` module skeleton

We don't have controllers for `Profile` in this lesson (Lesson 10 adds them when auth needs them). For now, just a module that registers the entity:

`backend/src/profile/profile.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from './entities/profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Profile])],
  exports: [TypeOrmModule],
})
export class ProfileModule {}
```

### 5.7 Update `app.module.ts` to register the new entity, disable `synchronize`, register the new module

`backend/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CategoriesModule } from './categories/categories.module';
import { Category } from './categories/entities/category.entity';
import { Language } from './languages/entities/language.entity';
import { LanguagesModule } from './languages/languages.module';
import { Organization } from './organizations/entities/organization.entity';
import { OrganizationsModule } from './organizations/organizations.module';
import { Otp } from './otp/entities/otp.entity';
import { OtpModule } from './otp/otp.module';
import { Price } from './prices/entities/price.entity';
import { PricesModule } from './prices/prices.module';
import { Qualification } from './qualifications/entities/qualification.entity';
import { QualificationsModule } from './qualifications/qualifications.module';
import { User } from './user/entities/user.entity';
import { UserModule } from './user/user.module';
import { ExpertsModule } from './experts/experts.module';
import { Expert } from './experts/entities/expert.entity';
import { Profile } from './profile/entities/profile.entity';
import { ProfileModule } from './profile/profile.module';
import { DataSource } from 'typeorm';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT') || 5432,
        password: configService.get<string>('DB_PASS', ''),
        username: configService.get<string>('DB_USER', 'postgres'),
        entities: [
          Organization,
          Category,
          Qualification,
          Price,
          User,
          Otp,
          Language,
          Expert,
          Profile,
        ],
        database: configService.get<string>('DB_NAME', 'expert-finder'),
        synchronize: false,                        // ← was true
        logging: configService.get<string>('NODE_ENV') !== 'production',
      }),
      dataSourceFactory: async (options) => {
        const ds = new DataSource(options);
        return ds.initialize();
      },
    }),
    OrganizationsModule,
    CategoriesModule,
    QualificationsModule,
    PricesModule,
    LanguagesModule,
    UserModule,
    OtpModule,
    ExpertsModule,
    ProfileModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### 5.8 Wire up a `data-source.ts` so migrations can be run from the CLI

`backend/src/data-source.ts`:

```ts
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { Category } from './categories/entities/category.entity';
import { Expert } from './experts/entities/expert.entity';
import { Language } from './languages/entities/language.entity';
import { Organization } from './organizations/entities/organization.entity';
import { Otp } from './otp/entities/otp.entity';
import { Price } from './prices/entities/price.entity';
import { Profile } from './profile/entities/profile.entity';
import { Qualification } from './qualifications/entities/qualification.entity';
import { User } from './user/entities/user.entity';

loadEnv();

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASS ?? '',
  database: process.env.DB_NAME ?? 'expert-finder',
  entities: [
    User,
    Profile,
    Otp,
    Category,
    Expert,
    Language,
    Organization,
    Price,
    Qualification,
  ],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
  synchronize: false,
  logging: false,
});
```

### 5.9 The initial migration

This is where the schema actually changes. We're going to do this as one large migration so you can see the whole picture at once. In Lesson 50 you'll learn to split per change; for now, one migration that fixes the existing entities is the right granularity.

`backend/src/migrations/1700000000000-initial.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1700000000000 implements MigrationInterface {
  name = 'Initial1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Required extensions
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext;`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`); // for gen_random_uuid()

    // 2. Fix the users table — add columns if they don't exist
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS google_id varchar(255),
        ADD COLUMN IF NOT EXISTS google_email citext,
        ADD COLUMN IF NOT EXISTS token_version int NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS is_email_verified boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
        ALTER COLUMN email TYPE citext USING email::citext,
        ALTER COLUMN pass_hash DROP NOT NULL;
    `);

    // 3. Case-insensitive uniqueness on email
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
    `);

    // 4. Google ID uniqueness (NULL allowed multiple times via COALESCE)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_id ON users (google_id)
      WHERE google_id IS NOT NULL;
    `);

    // 5. Create profiles table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id              bigserial PRIMARY KEY,
        user_id         int NOT NULL UNIQUE,
        full_name       varchar(80),
        phone           varchar(32),
        photo_url       varchar(255),
        address         text,
        date_of_birth   date,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_profiles_user FOREIGN KEY (user_id)
          REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // 6. Rebuild otp table — the old OneToOne was a dead end.
    // Drop old FK if it exists; old shape was (id, user_id [unique], otp_type, one_time_code, expires_at).
    await queryRunner.query(`ALTER TABLE IF EXISTS otp DROP CONSTRAINT IF EXISTS fk_otp_user;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_otp_user_id;`);

    // Add new columns, keeping the data we can.
    await queryRunner.query(`
      ALTER TABLE otp
        ADD COLUMN IF NOT EXISTS purpose otp_purpose_enum,
        ADD COLUMN IF NOT EXISTS code_hash varchar(80),
        ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS used_at timestamptz,
        ADD COLUMN IF NOT EXISTS last_sent_at timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS request_ip inet,
        ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_otp_user_purpose_expires
      ON otp (user_id, purpose, expires_at DESC);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_otp_active
      ON otp (user_id, purpose)
      WHERE used_at IS NULL;
    `);

    // 7. Make sure the otp_purpose_enum exists
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'otp_purpose_enum') THEN
          CREATE TYPE otp_purpose_enum AS ENUM ('email_verification', 'password_reset');
        END IF;
      END$$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // We accept that dropping the schema is fine in dev. In production you'd
    // write a more careful down that preserves data.
    await queryRunner.query(`DROP TABLE IF EXISTS otp;`);
    await queryRunner.query(`DROP TABLE IF EXISTS profiles;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_users_google_id;`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_users_email_lower;`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS google_id,
        DROP COLUMN IF EXISTS google_email,
        DROP COLUMN IF EXISTS token_version,
        DROP COLUMN IF EXISTS updated_at;
    `);
    await queryRunner.query(`DROP TYPE IF EXISTS otp_purpose_enum;`);
  }
}
```

**Notice five things:**

1. **Idempotency.** `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Running the migration twice doesn't break.
2. **Partial unique index.** `WHERE google_id IS NOT NULL` lets many rows have `NULL` google_id (the default), but the moment one is set, it must be unique. Postgres partial indexes are how you do nullable-uniqueness.
3. **`citext` extension.** Case-insensitive text type. We didn't want `"Bob@x.com"` and `"bob@x.com"` to be two accounts.
4. **`ON DELETE CASCADE`** on `profiles.user_id`. Deleting a user nukes their profile. Lesson 10 will set up the same for `otp.user_id` and `experts.user_id`.
5. **Enum type created with `DO $$ ... $$;`.** Postgres doesn't have `CREATE TYPE IF NOT EXISTS` directly; this is the standard guard pattern.

### 5.10 Add a `.env.example` (never commit `.env`)

`backend/.env.example`:

```env
NODE_ENV=development
PORT=3000

# Postgres
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=postgres
DB_NAME=expert-finder

# Auth secrets — replace with 32+ random bytes in production:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
JWT_ACCESS_SECRET=replace_me_access
JWT_REFRESH_SECRET=replace_me_refresh
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback

# Mail (Lesson 20) — SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Expert Finder <no-reply@example.com>"

# Frontend redirect after OAuth (Lesson 20)
FRONTEND_URL=http://localhost:3001
```

### 5.11 Add a script to package.json for running migrations

You already have:

```json
"typeorm": "typeorm-ts-node-commonjs",
"migration:run": "npm run typeorm -- migration:run -d src/data-source.ts"
```

Add:

```json
"migration:revert": "npm run typeorm -- migration:revert -d src/data-source.ts",
"migration:generate": "npm run typeorm -- migration:generate -d src/data-source.ts",
"migration:create": "npm run typeorm -- migration:create"
```

### 5.12 Run the migration against your local Postgres

```bash
# Make sure DB exists
psql -U postgres -c "CREATE DATABASE \"expert-finder\";"

# Run
npm run migration:run
```

You should see a log like:

```
query: SELECT * FROM "migrations" ...
query: CREATE EXTENSION IF NOT EXISTS citext;
...
Migration Initial1700000000000 has been executed successfully.
```

### 5.13 Verify the schema

```bash
psql -U postgres -d expert-finder -c "\d users"
psql -U postgres -d expert-finder -c "\d profiles"
psql -U postgres -d expert-finder -c "\d otp"
```

You should see the new columns, the unique indexes, and the citext type on `email`.

---

## 6. Tests

### 6.1 Unit test: ensure `User` entity loads

`backend/src/user/user.entity.spec.ts`:

```ts
import { DataSource } from 'typeorm';
import { User } from './entities/user.entity';

describe('User entity', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({
      type: 'sqlite',                       // any in-memory DB
      database: ':memory:',
      dropSchema: true,
      entities: [User],
      synchronize: true,
    });
    await ds.initialize();
  });
  afterAll(() => ds.destroy());

  it('creates a user with default role=client', async () => {
    const repo = ds.getRepository(User);
    const u = repo.create({ email: 'A@x.com' }); // mixed case
    await repo.save(u);
    const found = await repo.findOneByOrFail({ email: 'a@x.com' }); // lower-case
    expect(found.role).toBe('client');
    expect(found.tokenVersion).toBe(1);
    expect(found.isEmailVerified).toBe(false);
  });
});
```

(I'd skip sqlite-vs-postgres testing here in favor of a real testcontainer; Lesson 50 sets this up.)

### 6.2 Migration test: verify the up/down round-trip

Lesson 50 will add a CI job that runs the migration against an ephemeral Postgres, asserts the expected schema, then runs `down` and asserts the original. For now, manually:

```bash
npm run migration:revert
psql -U postgres -d expert-finder -c "\d users"
npm run migration:run
```

The schema should be back.

---

## 7. Self-check (answer in writing)

1. Why is `OneToOne` from `User` to `Otp` wrong? What does the right model look like?
2. What's the difference between `citext` and `varchar` for the `email` column? Why does it matter for login?
3. Why are we storing `code_hash` instead of the OTP code itself? What does it cost us at verify time?
4. Explain in one sentence why `synchronize: true` is removed in this lesson.
5. What is `tokenVersion` for? When does it increment?
6. Why a **partial unique index** on `google_id` and not a plain `unique`?
7. Why does the migration use `DO $$ BEGIN IF NOT EXISTS ... $$;` for the enum type?
8. If a teammate runs the migration twice by mistake, what happens? (Look at the SQL.) What changes would you make so even an accidental double-run is safe?

---

## 8. Common mistakes I expect you to make

| Mistake                                                                       | What goes wrong                                                | Fix                                                                       |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|---------------------------------------------------------------------------|
| Forgetting `select: false` on `passwordHash` and `codeHash`                   | Hashes get logged, sent to the client, end up in analytics     | Always `select: false` on anything secret                                |
| Using `varchar` for `email`                                                   | `"Bob@x.com"` and `"bob@x.com"` create two accounts           | Use `citext` or store normalized lowercase                                |
| `unique: true` on `googleId` without `WHERE google_id IS NOT NULL`            | First user without Google blocks every subsequent user         | Partial unique index in the migration                                     |
| Renaming a column in the entity without a migration                           | TypeORM silently drops the column on next boot — data lost    | Every schema change goes through a migration                              |
| Skipping the `down` migration                                                 | Can't roll back, dev gets stuck                                | Write `down` even if it's destructive; document it                        |
| Hardcoding `JWT_SECRET=secret` in `.env`                                       | Token forgery if `.env` leaks                                  | 32+ random bytes; never reused across envs                                |
| Adding a column with `default: null` and forgetting `nullable: true`           | Postgres rejects inserts                                       | Match `nullable` to default semantics                                    |

---

## 9. What we just enabled for Lesson 10

- A user can have many OTPs across time, each with a purpose and a cooldown — exactly what `/auth/resend-otp` needs.
- A user can register with email+password *or* Google, with no schema change to switch between them.
- A user can be soft-deleted and have all their refresh tokens invalidated in O(1) via `tokenVersion`.
- The DB will not silently drift because `synchronize: false` and migrations own the schema.

Lesson 10 (theory) and Lesson 20 (auth endpoints) build on this. Don't move on until the migration runs cleanly and your tests pass.
