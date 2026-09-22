# Lesson 10 — Auth Theory: The Threats, The Tokens, The Trade-offs

> **What you'll get:** the vocabulary, the threats, and the design decisions behind every line of code we'll write in Lesson 20. By the end, you should be able to explain *why* the auth flow looks the way it does, and predict three problems before they happen.
>
> **This lesson has no code.** That's deliberate. Jumping into code without this lesson is how you build a login page that's correct by accident. Read it twice.

---

## 1. Goal

After this lesson you can:

1. State the difference between **authentication** (who is this) and **authorization** (what may they do), and know which guard handles which.
2. List the top five threats to your auth flow and the defense for each.
3. Justify the JWT-in-`httpOnly`-cookie choice over localStorage, sessions, and other variants.
4. Explain why we rotate refresh tokens and how reuse-detection works.
5. Explain the entire OTP lifecycle: generation, hashing, cooldown, brute-force, expiration, single-use.
6. Sketch the Google OAuth flow as a sequence diagram.
7. Say "I would put this in env, not in code" without being prompted.

---

## 2. Why this matters

Authentication is the most-attacked surface in your app. It is also the part of the codebase where being 90% right means 100% compromised. A junior developer who builds a working login page has shipped a vulnerability. A senior developer who builds a working login page has shipped a vulnerability *and* documented how it could happen.

The reason this lesson has no code is that the cost of misunderstanding the theory is invisible until production. You will not see the bug in dev. You will not see it in QA. You will see it when an attacker has already drained a few accounts.

So we read first.

---

## 3. Concepts

### 3.1 Authentication vs. authorization

These two words are not synonyms. Conflating them is a senior-engineer interview red flag.

- **Authentication ("AuthN"):** *Who is this person?* Login. Register. Verify email. Reset password.
- **Authorization ("AuthZ"):** *What may they do?* "Is this user an admin?" "Can this client see this draft expert profile?"

In NestJS we express these as two separate concerns:

| Concern            | Mechanism                             | Example                                |
|--------------------|---------------------------------------|----------------------------------------|
| Authentication     | `JwtAuthGuard` (or `LocalAuthGuard`)  | Validates a JWT and sets `req.user`    |
| Authorization      | `RolesGuard` + `@Roles(UserRole.EXPERT)` | Checks `req.user.role === 'expert'` |

A common bug: putting role checks in the JWT strategy ("only admins can have a token"). That conflates AuthN with AuthZ. Fix it by making every authenticated request carry only the user's identity in the JWT, and checking roles per-endpoint via a guard.

### 3.2 The five threats

Every auth flow has these threats. Memorize them; defend them in order.

#### Threat 1: Credential stuffing

**The attack:** an attacker has 10M email-password pairs from a different site's breach. They automate your login endpoint and try them all.

**The defenses:**

- **Rate-limit by IP and by email.** A real user types 1 password per 5 seconds; an attacker fires 1000/second. The difference is obvious in traffic patterns.
- **Strong passwords.** NIST 800-63B dropped the old "must contain 3 of 4 character classes" rule; now they want a **minimum length of 8 (we use 10) and a check against known breach lists** like HaveIBeenPwned. We implement this in Lesson 20.
- **MFA / email verification gating.** Even if the password is correct, you can require an OTP step before issuing a session.

#### Threat 2: Brute force

**The attack:** the attacker knows an email address and tries every password.

**Defense:** the same as credential stuffing, plus:

- **Constant-time password comparison.** `bcrypt.compare` does this; `===` does not. A timing-attack-aware attacker can leak password length by measuring response times.
- **Account lockout.** After N failed attempts, lock for K minutes. We don't lock by email alone (causes DoS), we lock by IP+email pair.
- **Hashing cost.** `bcrypt` cost 12 means ~250ms per attempt on a 2026 CPU. 1000 attempts = 4 minutes; 1M attempts = 70 hours. The attacker gives up.

#### Threat 3: Token theft (JWT leakage)

**The attack:** the attacker steals a JWT and replays it.

**Where tokens leak:**

- **localStorage / sessionStorage.** XSS gives the attacker everything.
- **Cookies without `httpOnly`.** JS can read them, so XSS gives the attacker everything.
- **Cookies without `secure`.** Plain HTTP on a coffee-shop Wi-Fi gives them everything.
- **Cookies without `sameSite`.** A CSRF on your bank site submits a form to *your* server with your cookie attached.

**The defenses (combined):**

- **`httpOnly`** — JS cannot read the cookie.
- **`secure`** — only sent over HTTPS.
- **`sameSite=lax`** — sent on top-level navigation but not on cross-site sub-requests.
- **Short access-token lifetime** (15 min) — even if stolen, the window is small.
- **Refresh-token rotation + reuse detection** — see §3.4.
- **Bind tokens to a fingerprint.** Optional. Optional because it's a tradeoff: tighter security vs. a hostile UX when users switch networks.

**The decision:** Lesson 20 puts the access token in `httpOnly`, `secure`, `sameSite=lax` cookies. We *also* support `Authorization: Bearer` for mobile clients that can't share a cookie store.

#### Threat 4: Replay of OTPs

**The attack:** the attacker intercepts an OTP email (DNS hijack, mail-server breach, shoulder-surfing).

**Defenses:**

- **OTP TTL.** 5 minutes, per your spec.
- **Single-use.** Mark `usedAt` after a successful verification.
- **Hashed at rest.** See §3.5.
- **Max attempts.** Lock after 5 wrong tries.
- **Don't send the OTP over the same channel as the auth.** Email is fine for this MVP; SMS is famously vulnerable to SIM swap. SMS-based OTP is out of scope for you.

#### Threat 5: OAuth account takeover

**The attack:** the attacker goes through your Google OAuth flow with their Google account, then changes their email in your app to point at the victim's. Now the victim logs in with Google and gets the attacker's profile.

**The defense:** when a Google login lands, if the email already exists with a Google account, **link**, do not create. If the email exists with a password account but no Google link, **link** only after the user proves they own the original (re-verify by sending an OTP to the existing email). Never trust an OAuth provider's email as the primary identifier without checking.

Lesson 20 implements this carefully.

### 3.3 JWT vs. server sessions vs. encrypted tokens

Three ways to carry "I am authenticated".

| Approach               | State lives in       | Revoke by                          | Pros                                                | Cons                                                              |
|------------------------|----------------------|------------------------------------|-----------------------------------------------------|-------------------------------------------------------------------|
| Server session (cookie = session ID) | DB / Redis          | Delete the session row             | Easy to revoke; small cookie                        | DB lookup per request; scaling requires sticky sessions or shared store |
| JWT (signed)           | Client cookie        | Wait for expiry, or check `tokenVersion` | Stateless; scales without a shared store           | Can't revoke instantly; leaked token works until expiry            |
| JWT (encrypted, JWE)   | Client cookie        | Same as above                      | Payload not readable by client                      | Rarely needed; adds complexity                                     |
| **JWT + refresh-token rotation** | DB (refresh only) | Mark refresh revoked, bump `tokenVersion` | Stateless access; revocable refresh                 | More moving parts; reuse-detection needed                          |

**We use the last one.** The access token is a short-lived JWT in a cookie; the refresh token is a long-lived JWT *also* in a cookie, but its hash is in the DB so we can revoke it.

### 3.4 Refresh-token rotation and reuse detection

This is the part junior engineers skip. Don't.

**The flow:**

1. User logs in. Server creates:
   - Access token (15 min, signed, contains `sub`, `role`, `tv`).
   - Refresh token (7 days, signed, contains `sub`, `jti`).
   - Refresh-token row: `{ id: <jti>, user_id, hash, expires_at, replaced_by: null }`.

2. User comes back 16 minutes later. Access token is expired. Client calls `/auth/refresh` with the refresh token.

3. Server checks:
   - Refresh row exists?
   - `revoked_at` is null?
   - Token's `jti` matches row's id?
   - Hash matches?

4. If yes:
   - **Mark the old refresh row revoked, set `replaced_by = <new jti>`.**
   - Issue a new access token + new refresh token.

5. If no:
   - **Reject.** If the *token* itself is valid but the *row* is already revoked, this is **reuse** — someone stole the refresh token. Revoke every refresh token for that user; require re-login.

**The reuse-detection rule:** *if you ever see a refresh-token hash that was already used, treat the entire token chain as compromised.* This is because either (a) someone stole the token and is using it before the legitimate client, or (b) someone stole it from the legitimate client and is replaying it. Either way, the legit client should re-authenticate.

This is why we hash refresh tokens at rest. If our DB leaks, the attacker gets hashes they can't use (because we revoked them) — not bearer tokens.

### 3.5 The OTP lifecycle

A complete picture of an OTP's life:

```
Generate          Issue             Verify            Expire / Lock
────────────      ─────────────     ─────────────     ──────────────
6 random digits   Hash (bcrypt 10)  Lookup row        expires_at < now → refuse
                  Save to DB        Hash submitted    attempts >= max → mark used
                  Send email        bcrypt.compare    used_at != null → refuse
                  Set lastSentAt    If match: mark used
                  Return 201        Increment attempts
```

**The generate step:** use `crypto.randomInt(0, 1_000_000)` then `padStart(6, '0')`. Don't use `Math.random()` — it's not cryptographically secure. (Lesson 20 wires this in.)

**The cooldown step:** on resend, check `now - last_sent_at`. If `< 60s`, return 429.

**The verify step:** *before* comparing, increment `attempts`. This prevents a race condition where two parallel requests both see `attempts = 4` and both succeed at `5`. The increment-and-check is one transaction.

**The lockout step:** if `attempts >= maxAttempts`, mark `usedAt` and refuse further attempts for this row. The user has to request a new OTP (which resets the counter via a new row, subject to the cooldown).

### 3.6 Google OAuth, end-to-end

```
   Browser           Our API              Google
     │                  │                    │
     │ GET /auth/google │                    │
     │ ───────────────► │                    │
     │                  │ 302 → accounts.google.com/o/oauth2/...
     │ ◄─────────────── │                    │
     │                                           (user logs in / grants)
     │ ◄─────────── 302 /auth/google/callback?code=xyz
     │ ───────────────► │                    │
     │                  │ POST /token (code → id_token) ──►
     │                  │ ◄──── id_token, access_token ─────
     │                  │ 1. verify id_token signature
     │                  │ 2. extract sub (google_id), email, email_verified
     │                  │ 3. find user by google_id or email
     │                  │    - by google_id: log in
     │                  │    - by email + no google_id: link & log in (mark verified)
     │                  │    - new: create user (role=client, isEmailVerified=true)
     │                  │ 4. issue access + refresh cookies
     │ ◄─────────── 302 /profile  Set-Cookie: access=...
```

The key insight: **`isEmailVerified` is set to `true` automatically** for Google-linked users because Google has already verified the email. This is the whole point of "Sign in with Google".

The key risk: **linking**. If someone has an account with `email = bob@x.com` (password-only) and Google later tells us "someone with email `bob@x.com` is logging in", we should not silently merge those accounts. Two safer strategies:

- **Strict linking:** require the user to log in with their password *first*, then click "Link Google" in their settings. (Lesson 20 implements this for simplicity.)
- **Verified linking:** when an OAuth login lands on an existing email, send a one-time OTP to that email and require the user to enter it before linking. (More secure, more friction.)

For your MVP: strict linking via Settings endpoint, **not** automatic linking on first Google login. This is a deliberate product choice; explain it in your README.

### 3.7 Rate limiting — the forgotten control

You already have it in your spec ("1-minute resend cooldown"). But rate limiting is also for:

- `/auth/login` — 5 attempts per 15 min per IP+email.
- `/auth/register` — 5 attempts per hour per IP (prevents spam signups).
- `/auth/forgot-password` — 3 per hour per email (prevents OTP email flooding).
- `/search/experts` — 60 per minute per IP (cheap DoS protection).
- `/search/suggest` — 120 per minute per IP (typeahead is hot).

Lesson 20 implements these with `@nestjs/throttler`. Lesson 50 makes the store pluggable (Redis in prod).

### 3.8 Logging and observability

Every auth event should be logged, **but never with the secret**.

| Event                       | Log                                           |
|-----------------------------|-----------------------------------------------|
| Register succeeded          | `{ userId, email_hash, ip }`                  |
| Register failed             | `{ reason: 'duplicate_email', ip }`           |
| Login succeeded             | `{ userId, ip, userAgent }`                   |
| Login failed (wrong pass)   | `{ email_hash, ip, attempt: 3 }`              |
| OTP issued                  | `{ userId, purpose, ip }` — no code           |
| OTP verified                | `{ userId, purpose, attempts: 1 }`            |
| OTP failed                  | `{ userId, purpose, attempts: 4, remaining: 1 }` |
| Refresh succeeded           | `{ userId, jti_old, jti_new }`                |
| Refresh reuse detected      | `{ userId, jti, severity: 'critical' }`       |
| Google login succeeded      | `{ userId, googleId_hash, isNew: true }`      |

`email_hash` = `sha256(email + SERVER_PEPPER)`. This lets you correlate "did this email try to log in?" without putting the email in logs (which may be subject to GDPR right-to-erasure in plaintext logs).

Lesson 50 sets up the pino logger and the request-id interceptor. Lesson 20 just calls the logger with these shapes.

---

## 4. Decision points (commit or push back)

| Decision                                               | My choice                                                    | The alternative                          |
|--------------------------------------------------------|--------------------------------------------------------------|------------------------------------------|
| Access token storage                                   | `httpOnly` cookie (primary) + `Authorization: Bearer` (fallback) | localStorage (XSS-risky), URL param (logged everywhere) |
| Refresh token storage                                  | `httpOnly` cookie                                            | localStorage (worse; same risks)        |
| Access token lifetime                                  | 15 min                                                       | 5 min (more refresh traffic), 1 hour (larger hijack window) |
| Refresh token lifetime                                 | 7 days, rotated                                              | 30 days (longer hijack window)            |
| Password hashing                                       | `bcrypt` cost 12                                             | argon2id (better, but extra dep)         |
| OTP hashing                                            | `bcrypt` cost 10                                             | HMAC-SHA256 (faster, less brute-force bounded) |
| OTP length                                             | 6 digits, zero-padded                                        | 8 digits (more typing, fewer collisions) |
| OTP TTL                                                | 5 minutes                                                    | 10 minutes (worse window, more support tickets) |
| OTP resend cooldown                                    | 60 seconds                                                   | 30s / 120s                              |
| OTP max attempts                                       | 5, then row is marked `usedAt` (next resend required)        | 3 / 10 (more paranoid / friendlier)      |
| Login rate limit                                       | 5 / 15min / IP+email                                         | 3 / 30min (more paranoid)               |
| Register rate limit                                    | 5 / hour / IP                                                | 1 / hour / IP (most paranoid)           |
| Forgot-password rate limit                             | 3 / hour / email                                             | 1 / hour / email                        |
| OAuth linking strategy                                 | Strict (link from settings, not on first login)              | Verified (OTP gate on first link)       |
| Cookie `sameSite`                                      | `lax`                                                        | `strict` (breaks OAuth callback)         |
| JWT signing                                            | HS256 with 32-byte random secret                             | RS256 with JWKS (heavier; needed for many services) |
| Token claims                                           | `{ sub, role, tv, iat, exp }`                                | Custom claims like `email` (only if needed; small token = good) |
| `User.passwordHash` select strategy                    | `select: false` always                                       | Two repo methods (findOne vs findOneWithSecret) |
| Refresh reuse detection                                | Revoke entire chain                                          | Soft warn + log (insufficient)           |

These are all defensible. None are sacred. If you have a different opinion, write it down *before* Lesson 20 — we'll build on top of whichever you pick.

---

## 5. The sequence diagrams, end-to-end

### 5.1 Register → verify email → access

```
User           Frontend       /auth/register    /auth/verify-email
 │                 │                │                    │
 │ Submit form     │                │                    │
 │ ───────────────►│ POST /register │                    │
 │                 │ ──────────────►│                    │
 │                 │                │ 1. Validate input  │
 │                 │                │ 2. Check email not used
 │                 │                │ 3. Hash password (bcrypt 12)
 │                 │                │ 4. INSERT user (isEmailVerified=false)
 │                 │                │ 5. Issue OTP, hash, INSERT otp row
 │                 │                │ 6. Send email (async)
 │                 │ 201 { userId } │                    │
 │                 │ ◄──────────────│                    │
 │                 │ (redirect to /verify-email)         │
 │                 │                │                    │
 │ Enters OTP      │                │                    │
 │ ───────────────►│ POST /verify-email { code }         │
 │                 │ ────────────────────────────────────►
 │                 │                │                    │ 1. Lookup latest active OTP
 │                 │                │                    │ 2. Check attempts < max
 │                 │                │                    │ 3. bcrypt.compare(code, hash)
 │                 │                │                    │ 4. If match: UPDATE user
 │                 │                │                    │    SET isEmailVerified=true
 │                 │                │                    │    UPDATE otp SET usedAt=now()
 │                 │                │                    │ 5. Issue access+refresh, set cookies
 │                 │ 200 { role: 'client' }              │
 │                 │ ◄────────────────────────────────────│
 │ Redirect to /profile       │                    │
```

### 5.2 Login with refresh rotation

```
Client            /auth/login         /auth/refresh
 │                    │                    │
 │ POST { email, pass }                  │
 │ ──────────────────► │                  │
 │                    │ 1. Find user by email
 │                    │ 2. Verify password (bcrypt.compare)
 │                    │ 3. Check isEmailVerified
 │                    │ 4. Generate access+refresh JWTs
 │                    │ 5. INSERT refresh row (hash, expires_at)
 │                    │ 6. Set-Cookie: access=...
 │                    │    Set-Cookie: refresh=...
 │ 200                │                  │
 │ ◄──────────────────│                  │
 │                    │                  │
 │ (16 min later)     │                  │
 │ POST /refresh (cookie: refresh=...)   │
 │ ─────────────────────────────────────►
 │                    │                  │ 1. Verify JWT signature
 │                    │                  │ 2. Lookup refresh row by jti
 │                    │                  │ 3. Compare hash
 │                    │                  │ 4. If revoked → REUSE → revoke all
 │                    │                  │ 5. Else: mark old revoked,
 │                    │                  │    INSERT new row,
 │                    │                  │    issue new access+refresh
 │ 200 (rotated cookies)
 │ ◄────────────────────────────────────│
```

### 5.3 Forgot/reset password

```
User             /auth/forgot-password         /auth/reset-password
 │                    │                              │
 │ POST { email }     │                              │
 │ ──────────────────►│                              │
 │                    │ 1. Lookup user                │
 │                    │ 2. Always 200 (don't leak)    │
 │                    │ 3. If user: issue PASS_RESET OTP
 │                    │ 4. Send email                 │
 │ 200 (always)       │                              │
 │ ◄──────────────────│                              │
 │                    │                              │
 │ Enters OTP+new pass│                              │
 │ ───────────────────┼─────────────────────────────►│
 │                    │                              │ 1. Find active OTP
 │                    │                              │ 2. Verify code
 │                    │                              │ 3. Hash new password
 │                    │                              │ 4. UPDATE user
 │                    │                              │ 5. Mark OTP usedAt
 │                    │                              │ 6. Bump tokenVersion
 │                    │                              │    (invalidates all sessions)
 │ 200                │                              │
 │ ◄──────────────────┼──────────────────────────────│
 │ Re-login required  │                              │
```

**Why always 200 on forgot-password?** If the endpoint returns 200 only for existing emails, an attacker can enumerate which addresses are registered. By returning 200 with the same body regardless of whether the email exists, we close that side-channel. The attacker sees an identical response time and body either way. The attacker who *controls* the email still doesn't get a token.

---

## 6. Things we explicitly are *not* doing in this MVP

- **2FA / TOTP.** Your spec doesn't include it; out of scope for Lessons 10–20. Easy to add later (one column on `User` for the TOTP secret).
- **Email change verification.** Re-verify on email change. *Not* in your spec.
- **Login alerts.** "We noticed a login from a new device." Nice to have; out of scope.
- **Anomaly detection.** Beyond what the throttler does.
- **GDPR data-export endpoint.** Out of scope here; Lesson 50 lists it as a follow-up.
- **Account recovery codes.** Out of scope.

---

## 7. Self-check (answer in writing)

1. What's the difference between authentication and authorization? Which guard handles each in our setup?
2. List the five threats and one defense for each.
3. Why is `localStorage` a poor choice for JWT storage, even though it's the easiest to implement?
4. What is reuse-detection on a refresh token? Why do we hash refresh tokens at rest?
5. Why does the OTP verify step *increment attempts before* the comparison, not after?
6. Why does `/auth/forgot-password` return 200 even when the email doesn't exist?
7. Why must Google OAuth users have `isEmailVerified = true` automatically, while password-register users do not?
8. What's the difference between "rate limit per IP" and "rate limit per IP+email"? Why is the second better for login?
9. When the refresh token rotation detects reuse, why do we revoke the *whole chain* and not just the offending token?
10. Why is `sameSite=strict` wrong for our OAuth callback?

If you can answer all ten in two sentences each, you are ready for Lesson 20.
