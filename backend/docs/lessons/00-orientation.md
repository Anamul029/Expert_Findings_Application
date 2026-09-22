# Lesson 00 — Orientation: How to Read These Lessons

> **What you'll get:** a mental map of the entire backend build, the rules I follow when writing code in these lessons, and how to actually use this material so you don't just *read* it and forget it.
>
> **What you should do first:** open `Expert Finding.md`, `er-2.drawio`, `join-lesson.md`, `searching/search-feature-planning.md`, and `searching/search-api-design.md` in tabs. We will cross them constantly. If you have not read `join-lesson.md` yet, stop here and read it end-to-end. Everything in Lessons 05–40 assumes you understand 1:1, 1:N, M:N, onDelete, and indexes.

---

## 1. The destination

By the end of Lesson 50 you will have a backend that:

1. **Authenticates users the way production systems do**, not the way tutorials do.
   - Email + password with bcrypt, OWASP-compliant rate limiting, breach-list checking.
   - Email verification with rotating 6-digit OTPs, 5-minute TTL, 1-minute resend cooldown, brute-force lockout.
   - Google OAuth2 (Passport) that creates a verified user on first login and *links* an existing user on subsequent ones.
   - Forgot/reset password using a *separate* OTP purpose that does not collide with verification.
   - JWT in `httpOnly`, `secure`, `sameSite=lax` cookie (with a `Authorization: Bearer` fallback for mobile).
   - Refresh-token rotation; access tokens expire in 15 min, refresh in 7 days, reuse-detection logs the user out.
   - A `RoleGuard` and a `JwtAuthGuard` that your search endpoints will use to differentiate "logged in / not logged in".

2. **Searches experts the way product teams need**, not the way tutorials do.
   - One `/search/experts` endpoint with optional filters that compose with AND across filters and OR inside multi-selects (qualifications, languages).
   - Postgres `tsvector` full-text index for the free-text `q` parameter that matches `name`, `bio`, `category`, `organization` in one query — not four.
   - A scoring function that ranks by text match → category relevance → verification → Bayesian-adjusted rating → review count. We will explicitly avoid "highest rating wins" because 4.9 from 1 review should not beat 4.7 from 200 reviews.
   - A faceted response (qualification counts, price range observed) so the UI can show "BSc (18)" next to a checkbox instead of a blind list.
   - Empty-result suggestions computed server-side by re-running the query with one filter relaxed at a time.
   - Suggest endpoint (typeahead) separated from the full search endpoint so keystrokes don't hit the heavy query path.

3. **Is observably, defensibly production-ready.**
   - Migrations, not `synchronize: true`.
   - Structured request logging with a request-id.
   - Global exception filter that returns RFC-7807-shaped errors and never leaks a stack.
   - Rate limiting on auth and search endpoints.
   - CORS, helmet, body-size limits, cookie flags — all deliberate.
   - Jest unit tests for services; supertest e2e for the happy paths and the security paths (wrong OTP, expired OTP, brute force, broken CSRF).
   - A pre-deploy checklist.

---

## 2. What "production-ready" actually means (and what it does not)

I'm going to be strict about this term because junior engineers use it to mean "it runs on my laptop".

| Truly production-ready                                                        | Not production-ready (even if it feels like it)                |
|-------------------------------------------------------------------------------|----------------------------------------------------------------|
| Migrations committed; `synchronize: false`; schema drift caught in CI          | `synchronize: true` "because it's only dev"                     |
| Secrets in env vars; no `.env` committed; `.env.example` instead               | `JWT_SECRET=secret` in a committed `.env`                      |
| Rate-limited login + OTP endpoints                                            | "We'll add rate limiting later"                                |
| `bcrypt` cost tuned so a single hash takes ~250ms on the target CPU           | `bcrypt` cost 4 (cracked instantly) or `md5(password)`        |
| OTPs are single-use, time-limited, brute-force-limited, hashed at rest        | OTPs are cleartext in the DB                                   |
| JWT signing key is a 256-bit random string, rotated with overlap               | JWT signing key is `my-secret-123`                             |
| Cookies are `httpOnly`, `secure`, `sameSite=lax`, scoped to a path            | JWT in localStorage, no flags                                  |
| Errors never leak internals (no stack traces in 500 responses)                 | `throw err; res.status(500).send(err.stack)`                   |
| Indexes are present for every column used in `WHERE` and `ORDER BY`           | "Postgres is slow, we'll add indexes later"                    |
| `EXPLAIN ANALYZE` has been run on the slow queries                            | "It returned the right rows"                                   |
| Logs are structured (JSON), correlated by request-id                           | `console.log('user logged in')`                                |
| Health endpoints + readiness/liveness                                           | "It's running, what else do you need"                           |
| Secrets in DB are scoped to the columns that need them (`select: false`)       | `SELECT *` on `users` returning password hashes                |

If you remember nothing else from these lessons, remember that table.

---

## 3. How a lesson is structured

Every lesson in this series has the same anatomy:

```
1. Goal              — what you will be able to do at the end
2. Why this matters  — the real-world reason this exists
3. Concepts          — the theory, with diagrams
4. Decision points   — the trade-offs I considered, and why I picked one
5. Code              — drop-in files, in the order you should create them
6. Tests             — what to assert; how to run them
7. Self-check        — questions to answer before moving on
9. Common mistakes   — the bugs I expect you to write; pre-empt them
```

**You do not read these lessons top to bottom like a novel.** You read them with the editor open and `git checkout -b lesson-XX` ready. When a lesson says "create this file", you create it. When it says "why", you answer in your own words in a comment above the code, even if I'm telling you the answer. The act of *re-stating* a reason is what turns "I read about JWTs" into "I understand why we rotate refresh tokens".

---

## 4. The decisions I make for you (and why)

To save time, I will commit to these defaults unless a lesson explicitly opens the question. If you want to change one, bring it up *before* we build on top of it.

| Decision                                       | Default I will use                                      | What to push back on if you disagree                   |
|------------------------------------------------|--------------------------------------------------------|--------------------------------------------------------|
| ORM                                            | TypeORM (your choice already; the codebase uses it)     | Switching to Prisma/Drizzle is a separate project      |
| HTTP framework                                | NestJS (already chosen)                                 | Not a real choice — the codebase is Nest               |
| Database                                       | PostgreSQL (already chosen)                             | Not a real choice                                      |
| Password hashing                              | `bcrypt` cost 12, library `bcrypt` (not `bcryptjs`)     | "Use argon2id instead" is a valid push                 |
| JWT library                                    | `@nestjs/jwt` with HS256, 256-bit secret                | "Use RS256 with key rotation" — yes, but later         |
| Access token lifetime                          | 15 minutes                                              | Shorter (5m) if you accept more refresh traffic         |
| Refresh token lifetime                         | 7 days, rotated on every use                            | 30 days if you're OK with longer hijack windows        |
| OTP length                                     | 6 digits                                                | 8 digits if you have low traffic and hate support tickets |
| OTP TTL                                        | 5 minutes (matches your spec)                           | 10 minutes only if you have accessibility complaints   |
| Resend cooldown                               | 60 seconds (matches your spec)                          | 30s is fine; 120s is hostile                           |
| OTP max attempts                              | 5, then 15-minute lockout                               | 3/30m is more paranoid; 10/30m is friendlier           |
| Login rate limit                              | 5 attempts / 15 min / IP+email                          | Tunable in env                                         |
| Cookies                                        | `httpOnly`, `secure` (prod), `sameSite=lax`, `path=/`   | `sameSite=strict` breaks OAuth callbacks               |
| CORS                                           | Allowlist via env                                       | Don't `origin: '*'` ever                              |
| Validation                                     | `class-validator` DTOs at the boundary                  | Zod instead — possible but a bigger refactor           |
| Logging                                        | `pino` + `nestjs-pino`, request-id per request          | Winston is fine but slower                             |
| Rate limit store                               | In-memory for dev, Redis for prod                       | Don't ship prod with in-memory only                    |
| Migration tool                                 | TypeORM migrations, run via `npm run migration:run`     | Don't use `synchronize: true` in any env               |
| Tests                                          | Jest unit + supertest e2e                               | Vitest is fine too                                     |
| Folder structure                               | Feature modules: `auth/`, `search/`, `users/`           | Hexagonal/clean is overkill for your scale             |

---

## 5. The repo structure we will land at the end of Lesson 50

I want you to *see* the destination before we walk there, so the friction of each step makes sense.

```
backend/
├── docs/
│   ├── lessons/                    ← this folder
│   └── adr/                        ← architectural decision records (added in Lesson 50)
├── src/
│   ├── main.ts                     ← bootstrap (cookies, body limits, helmet, CORS, pino)
│   ├── app.module.ts               ← root module
│   ├── config/                     ← typed config (env schema with Joi/Zod)
│   ├── common/
│   │   ├── filters/                ← AllExceptionsFilter
│   │   ├── interceptors/           ← request-id, logging
│   │   ├── guards/                 ← JwtAuthGuard, RoleGuard, ThrottledGuard
│   │   ├── decorators/             ← @CurrentUser, @Roles, @Public
│   │   └── pipes/                  ← validation, parse-uuid
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts
│   │   │   └── google.strategy.ts
│   │   ├── guards/
│   │   │   └── jwt-refresh.guard.ts
│   │   └── dto/
│   │       ├── register.dto.ts
│   │       ├── verify-email.dto.ts
│   │       ├── login.dto.ts
│   │       ├── forgot-password.dto.ts
│   │       └── reset-password.dto.ts
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.service.ts
│   │   └── entities/
│   │       ├── user.entity.ts
│   │       └── profile.entity.ts
│   ├── otp/
│   │   ├── otp.module.ts
│   │   ├── otp.service.ts          ← generation, hashing, cooldown, attempts
│   │   └── entities/
│   │       └── otp.entity.ts       ← OneToMany with User, purpose field
│   ├── mail/
│   │   ├── mail.module.ts
│   │   └── mail.service.ts         ← nodemailer; SMTP via env
│   ├── search/
│   │   ├── search.module.ts
│   │   ├── search.controller.ts
│   │   ├── search.service.ts
│   │   ├── suggest.service.ts
│   │   └── dto/
│   │       └── search-experts.dto.ts
│   ├── experts/                    ← already exists; we extend it
│   ├── categories/                 ← already exists; we add the self-ref tree
│   ├── organizations/              ← already exists
│   ├── qualifications/             ← already exists
│   ├── languages/                  ← already exists
│   └── prices/                     ← already exists
├── migrations/                     ← versioned SQL; one .ts per change
│   ├── 1700000000000-init.ts
│   ├── 1700000000001-add-otp-fields.ts
│   ├── 1700000000002-add-profile.ts
│   ├── 1700000000003-add-search-indexes.ts
│   └── 1700000000004-add-google-fields.ts
├── seeds/                          ← dev seeds only; not for prod
├── test/
│   ├── jest-e2e.json
│   ├── auth.e2e.ts
│   └── search.e2e.ts
└── package.json
```

If a folder isn't in this list, we don't create it. The point of feature modules is that they map 1:1 to product capabilities.

---

## 6. How to use these lessons without burning out

A common failure mode: you read Lesson 05 in one sitting, nod along, then Lesson 10 makes no sense. The lessons **layer**. Lesson 10 assumes the schema from Lesson 05. Lesson 20 assumes the guards from Lesson 10. If you skip, you'll be confused.

**My recommended pace:**

1. Read the lesson once *without writing any code*, just to feel the shape.
2. Read it a second time, this time *opening the file I'm telling you to create* and typing the code in. Don't copy-paste — typing forces you to read.
3. Run the tests after each file. If a test fails, that is the lesson — read the error, don't suppress it.
4. Answer the self-check questions *in writing* before moving on. Voice-memo answers are fine.
5. Don't move on until the self-check passes. These are not gatekeeping questions; they're the things that *will* bite you in Lesson 30 if you didn't internalize them now.

If you only have 20 minutes, do steps 1 and 4. If you have an hour, do steps 1, 2, 3. Skip step 5 at your peril.

---

## 7. What is *not* in scope

To manage expectations:

- **Frontend.** Next.js is your choice; we only build API contracts and the response shapes. I will, however, write the API as if a strict frontend reviewer is reading it.
- **Deployment.** I give you a checklist and a Dockerfile. The act of pushing to AWS/Render/Railway is on you.
- **AI search (Journey 3).** Deferred. The endpoint is sketched in `search-api-design.md`; we won't build it.
- **Channels, Posts, Comments, Reacts, Reviews, Submissions.** Out of scope for this lesson series. The schema supports them; we just don't touch the modules.
- **Mobile-specific concerns.** The JWT cookie + Bearer fallback covers mobile. Push notifications, deep links — out.

---

## 8. Self-check before Lesson 05

Answer these in your own words. If you can't, go re-read the source.

1. Look at `er-2.drawio` (or `join-lesson.md` §3). Which tables currently in `backend/src/` are missing from the diagram's intended schema? (Hint: there's no `Profile` entity yet.)
2. Why is the current `Otp` entity (`OneToOne` to `User`) broken for a "resend OTP after 1 minute" feature? Write the failure scenario in two sentences.
3. Look at `app.module.ts`. What is the single biggest reason `synchronize: true` will hurt you, the moment this codebase goes near production? (One sentence.)
4. From `Expert Finding.md`, list every auth endpoint and the HTTP status it returns.
5. From `search-feature-planning.md` §13, what are the four stages the search request must pass through before results are returned?

When you can answer all five without re-opening the files, go to **Lesson 05**.