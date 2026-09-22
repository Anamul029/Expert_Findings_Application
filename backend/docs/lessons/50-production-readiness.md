# Lesson 50 — Production Readiness: The Polish That Makes It Real

> **What you'll get:** the cross-cutting concerns that span every module — logging, request ids, rate-limit storage, security headers, observability, deployment checks, and a concrete pre-launch checklist. After this lesson the project is genuinely deployable.
>
> **This is not theory.** Every recipe here is a real risk in production. Skipping one means a 3 a.m. page or a leaked token.

---

## 1. Goal

After this lesson:

- every request has a `requestId`, logged with method, path, status, duration, userId-if-known,
- logs are structured JSON, with secrets redacted,
- the throttler uses Redis in production (in-memory in dev),
- the API ships with security headers from `helmet`,
- CORS is locked to a single origin in prod,
- there's a `/health` (liveness) and `/ready` (readiness) endpoint,
- a Dockerfile and a `compose.yml` ready for staging,
- CI runs the migrations against an ephemeral Postgres and runs the e2e tests,
- a pre-launch checklist you can sign off.

---

## 2. Why this lesson is separate

Lessons 10–40 built features. Lesson 50 picks up everything that runs *across* features and would have been noise inside each one: where do you put a try/catch that wraps the whole request? Where do you put request-id generation? Where do you put the rate-limit store? The answers all live in *one place per concern*. Lesson 50 is that place.

---

## 3. The recipe list

### 3.1 Structured logging — pino

Install:

```bash
npm install nestjs-pino pino-http pino-pretty
```

`backend/src/common/logger/logger.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('nodeEnv') === 'production' ? 'info' : 'debug',
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.body.password',
              'req.body.code',
              'req.body.newPassword',
              'req.body.token',
            ],
            censor: '[REDACTED]',
          },
          transport:
            config.get<string>('nodeEnv') === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
})
export class AppLoggerModule {}
```

In `main.ts`, replace the default logger:

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
```

Now every log line is JSON-shaped with `req.id`, `req.method`, `req.url`, `res.statusCode`, `responseTime`. Search your logs by `req.id` and you have a full request trail.

### 3.2 Request-id interceptor

`backend/src/common/interceptors/request-id.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';

const HEADER = 'x-request-id';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const id = (req.headers[HEADER] as string) ?? randomUUID();
    req.id = id;
    res.setHeader(HEADER, id);
    return next.handle();
  }
}
```

Apply globally in `main.ts`:

```ts
app.useGlobalInterceptors(new RequestIdInterceptor());
```

Now the `x-request-id` is generated (or honored) on every request. Logs include it. Clients can include it for support tickets.

### 3.3 Rate-limit storage — Redis in prod

`backend/src/throttler-redis.storage.ts`:

```ts
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

export class RedisThrottlerStorage implements ThrottlerStorage {
  private redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url);
  }
  async increment(key: string, ttlMs: number): Promise<{ totalHits: number; timeToExpire: number }> {
    const r = await this.redis.multi().incr(key).pttl(key).exec();
    const total = (r?.[0]?.[1] as number) ?? 1;
    let ttl = (r?.[1]?.[1] as number) ?? -1;
    if (ttl < 0) {
      await this.redis.pexpire(key, ttlMs);
      ttl = ttlMs;
    }
    return { totalHits: total, timeToExpire: Math.ceil(ttl / 1000) };
  }
}
```

```bash
npm install ioredis
```

In `app.module.ts`:

```ts
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    ttl: 60_000,
    limit: 60,
    storage: process.env.NODE_ENV === 'production'
      ? new RedisThrottlerStorage(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379')
      : undefined,
  }),
})
```

In production with multiple app instances, the in-memory store gives each instance its own counter — meaning a 5-attempts/15min limit becomes 5×N on N instances. Redis is the only way to share the counter honestly.

### 3.4 Security headers, CORS, body limits

Already in `main.ts` from Lesson 20:

- `helmet()` — sets `X-Frame-Options`, `Strict-Transport-Security`, `X-Content-Type-Options`, etc.
- `credentials: true` — cookies over CORS.
- `app.use(express.json({ limit: '100kb' }))` — body size limit (Lesson 40 left this out, here's where it goes).

Add body size limits:

```bash
npm install express
npm install -D @types/express
```

```ts
import { json, urlencoded } from 'express';
app.use(json({ limit: '100kb' }));
app.use(urlencoded({ extended: true, limit: '100kb' }));
```

`100kb` is plenty for any DTO you have; larger requests are almost always abusive.

### 3.5 Health and readiness

`backend/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from 'src/auth/decorators/public.decorator';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller()
export class HealthController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Public()
  @Get('health')   // liveness — is the process alive?
  health() {
    return { ok: true, ts: new Date().toISOString() };
  }

  @Public()
  @Get('ready')    // readiness — can we serve traffic?
  async ready() {
    try {
      await this.ds.query('SELECT 1');
      return { ready: true, db: 'up' };
    } catch (e) {
      return { ready: false, db: 'down' };
    }
  }
}
```

Liveness vs. readiness:

- **Liveness** = "kill me if I'm broken". Kubernetes restarts the pod if this fails.
- **Readiness** = "send me traffic, but maybe not yet". Kubernetes holds traffic until this passes.

Don't conflate them. If your pod is briefly unable to reach the DB, you want it to *fail readiness* (no traffic) but *pass liveness* (don't restart).

### 3.6 Dockerfile

`backend/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.4
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN addgroup -g 1001 nodejs && adduser -S -u 1001 nestjs -G nodejs
USER nestjs
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

`backend/.dockerignore`:

```
node_modules
dist
coverage
.git
.env*
!.env.example
README.md
```

### 3.7 docker-compose for local + CI

`backend/compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: expert-finder
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 5

  api:
    build: .
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      NODE_ENV: production
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASS: postgres
      DB_NAME: expert-finder
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?must be set}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:?must be set}
      REDIS_URL: redis://redis:6379
      FRONTEND_URL: ${FRONTEND_URL}
    ports: ["3000:3000"]
    command: sh -c "node dist/data-source.js && node dist/main.js"
```

(Note: `dist/data-source.js` would have to expose the migration runner; in CI you'd run `npm run migration:run` separately. Adjust to taste.)

### 3.8 CI: GitHub Actions example

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: expert_finder_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    env:
      DB_HOST: localhost
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASS: postgres
      DB_NAME: expert_finder_test
      JWT_ACCESS_SECRET: test_access_secret_must_be_32_bytes_long_xx
      JWT_REFRESH_SECRET: test_refresh_secret_must_be_32_bytes_long_yy
      REDIS_URL: redis://localhost:6379
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typeorm -- migration:run -d src/data-source.ts
      - run: npm run test:cov
      - run: npm run test:e2e
```

The line `JWT_ACCESS_SECRET=test_access_secret_must_be_32_bytes_long_xx` is 48 chars; it satisfies the 32-byte minimum even though it's deterministic. Test secrets are deterministic on purpose — easier to debug.

### 3.9 Pre-launch checklist

Run this once, by hand, before every production deploy. Tick every box.

#### Security

- [ ] `synchronize: false` in `app.module.ts` for every env except the explicit `development` DB.
- [ ] `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are 32+ random bytes each. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`.
- [ ] No real Google client secrets in `.env.example`.
- [ ] `helmet()` is installed.
- [ ] CORS allowlist contains *only* the production frontend.
- [ ] Cookie `secure: true` in production.
- [ ] `forbidNonWhitelisted: true` on the global `ValidationPipe`.
- [ ] No endpoint returns `passwordHash`, `codeHash`, or any `select: false` column.

#### Data

- [ ] All migrations ran cleanly (`SELECT * FROM migrations ORDER BY id;`).
- [ ] Every FK has `ON DELETE` set intentionally (Lesson 05's review).
- [ ] `EXPLAIN ANALYZE` on `/search/experts` shows `Index Scan`, not `Seq Scan`.
- [ ] `EXPLAIN ANALYZE` on `/auth/login` shows an `Index Scan` on `lower(email)`.
- [ ] No tables are accidentally unindexed for their hot path.

#### Auth

- [ ] `/auth/forgot-password` is 200-only.
- [ ] Throttler limits: 5/15min login, 5/hr register, 3/hr forgot, 6/min resend-otp, 60/min search.
- [ ] `sudo node test/auth.e2e.ts` exercises reuse-detection.
- [ ] Refresh tokens rotate; chain kill works.
- [ ] Google OAuth callback is over HTTPS in prod (otherwise cookies' `secure` blocks them).

#### Reliability

- [ ] `/health` and `/ready` respond 200.
- [ ] Logs are JSON-shaped; `x-request-id` is logged.
- [ ] Sentry / Datadog / equivalent is wired up (or plan the hook).
- [ ] Migrations are reversible (`migration:revert` actually reverts cleanly).
- [ ] The DB has a backup strategy documented and tested (Lesson 50 lists this as a follow-up if you don't already have one).
- [ ] At least one runbook for: "users can't log in", "search returns empty", "OTP emails not going out".

#### Performance

- [ ] Cold-start p95 < 1s.
- [ ] `/search/experts` p95 < 200ms with 10k seed experts.
- [ ] `/auth/login` p95 < 500ms (bcrypt is the bottleneck).

---

## 4. Decision points

| Decision                                              | Default                            | Push back if                                         |
|-------------------------------------------------------|------------------------------------|------------------------------------------------------|
| Logger                                                | `nestjs-pino` (pino)               | You prefer Winston (slower JSON serialization)      |
| Throttler store                                       | In-memory dev, Redis prod          | Single-process dev / no Redis infra budget           |
| Body limit                                            | 100KB                              | You have legitimate >100KB payloads (rare)           |
| CORS                                                  | Single origin from env             | You host multiple subdomains (allowlist)            |
| Liveness vs. readiness split                          | Yes                                | You're not on K8s (one healthz is enough)            |
| Sessions / cookies                                    | JWT in `httpOnly` cookie           | You need server-side revocation today (sessions)    |
| Node version                                          | 22 LTS                              | Stuck on 20 (then drop `import` Node-only features) |
| DB version                                            | Postgres 16                       | Your platform only has 14/15 (still OK, watch `tsvector` changes) |
| CI service                                            | GitHub Actions                     | You use Jenkins/GitLab; ports the same idea        |

---

## 5. What's *not* in these lessons (intentional)

- **AI search (Journey 3).** Not in your MVP scope; `search-api-design.md` §7 sketches the contract.
- **Reviews / Posts / Comments / Channels.** Out of scope. The schema supports them.
- **Multi-region.** Not discussed. Standard pattern: deploy each region behind its own DB with a pgpooler or read-replica; your app already reads from one DataSource.
- **GDPR right-to-erasure endpoint.** Listed as a follow-up. The `delete` query + token bump is straightforward; the real work is auditing what user-derived data lives outside the user row (e.g. reviews).
- **Sentry / Datadog wiring.** Lesson 50 lists it as a checklist item; the actual hook is a 10-line `addHook` in `main.ts` once you have a project key.
- **Webhooks for user lifecycle.** "User deleted", "user verified email" — useful for analytics; out of MVP scope.

---

## 6. Self-check (the final boss)

You are done when you can answer all of these without re-reading the codebase:

1. **What's the difference between authentication and authorization?**
   *Answer: AuthN = who you are (login/JWT). AuthZ = what you may do (RolesGuard). Both are needed.*

2. **Why is `localStorage` the wrong place for JWTs?**
   *Answer: XSS gives the attacker the tokens; cookies with `httpOnly` don't.*

3. **What is reuse-detection on refresh tokens?**
   *Answer: If a revoked refresh row's hash is presented, every chain for that user is killed; tokenVersion is bumped.*

4. **Why does `/auth/forgot-password` return 200 unconditionally?**
   *Answer: Don't leak which emails are registered.*

5. **What's a `tsvector` and why do we need a trigger to maintain it?**
   *Answer: Tokenized search index. Cannot reference other tables from a generated column; trigger updates it when bio/category/profile changes.*

6. **Why Bayesian rating instead of raw `avg_rating`?**
   *Answer: An expert with 5.0 from 1 review shouldn't outrank 4.7 from 200.*

7. **What's the one failure mode `synchronize: true` will cause you in prod?**
   *Answer: TypeORM silently drops a renamed column and its data on the next deploy.*

8. **Why are OTPs hashed at rest?**
   *Answer: A DB leak shouldn't give attackers live tokens.*

9. **What's the difference between facet computation "naive" and "re-using the WHERE"?**
   *Answer: Naive requires finishing the search to get ids; reused-WHERE runs in parallel and is much cheaper.*

10. **What's one thing in your codebase right now that would fail a security review?**
    *(This one is for you to find. Search for `passwordHash` in your tests; check whether any endpoint returns `select: false` columns; check whether any query string-concatenates user input.)*

---

## 7. The post-launch actions

After deploy:

- Monitor `req.id` in logs to investigate any user reports.
- Watch `/search/experts` p95 — first sign of trouble is p99, not averages.
- Watch the mail queue — bounced OTP emails are a leading indicator of a misconfigured SPF/DKIM.
- Watch the rate-limiter logs for "ThrottlerException" — sustained 429s are a sign of an attack or a UX bug.

---

## 8. The follow-up roadmap (the things we deliberately didn't do)

In priority order:

| # | Item                                                  | Why                                                      | Effort       |
|---|-------------------------------------------------------|----------------------------------------------------------|--------------|
| 1 | AI search (`/search/ai-assist`)                       | Your MVP travel path                                     | 2 weeks      |
| 2 | Email change verification                            | Account takeover risk                                    | 1 day        |
| 3 | 2FA (TOTP) for high-value roles                      | Real protection                                          | 3 days       |
| 4 | Account deletion / GDPR data-export                  | Legal exposure                                           | 3 days       |
| 5 | Login alerts ("new device")                          | Trust signal                                             | 4 days       |
| 6 | Profile photos on object storage with signed URLs     | Currently we don't store photos                          | 1 week       |
| 7 | Reviews module                                       | Plan from your ER diagram                                | 2 weeks      |
| 8 | Channels + Posts + Comments                           | Plan from your ER diagram                                | 3 weeks      |
| 9 | Recommendations / personalization                     | Once you have enough data                               | 4 weeks      |
| 10| Move to Elasticsearch when `EXPLAIN ANALYZE` shows > 200ms p95 | When scale demands it                          | 2 weeks      |

Each is its own lesson series. None of them are blockers today.

---

## 9. The closing thought

Production-readiness isn't a checklist you tick once. It's a posture: every PR asks "does this leak secrets, lose data, or DoS the service?". Every migration has a `down`. Every endpoint has a test. Every query has been `EXPLAIN ANALYZE`'d. Every status code is intentional.

If you've worked through Lessons 05–50, you've internalized all of that for the auth and search domains. Apply the same lens to reviews, channels, posts, comments. The patterns repeat.

Now go ship it.
