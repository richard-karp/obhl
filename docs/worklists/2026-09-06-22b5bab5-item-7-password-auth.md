# 22b5bab5 — Item 7, phases 2 and 3: self-serve password auth

**Protocol — read this and nothing else to resume.**

1. ⛔ **THIS FILE IS CLOSED PROVENANCE. The work shipped** — PR #36, merged to
   `main` 2026-09-06 as `32262b5`, two commits (`ecb53af`, `2bcaf8c`). You
   almost certainly do not need it. What is still OUTSTANDING lives in section 7
   of `LAUNCH_READINESS_HANDOFF.md` (115 lines), which is where you should be.
   This file is the record of what was decided and why, kept because the
   reasoning is not derivable from the diff.
2. ⛔ **Hazards, still true:** the reset flow has **never sent a production
   email**, so do not tell anyone it works. `supabase db reset --linked` wipes
   production. Publishing a schedule is a one-way door and is unrelated to any
   of this.
3. Every number below was **watched appear**. Where a claim is a reading of the
   code rather than a measurement, it says so in those words.
4. Verify the code this describes with: `npx vitest run src/lib/actions/league-guards.test.ts`
   (7 passed) and `npx playwright test e2e/24-password-auth.spec.ts` (6 passed).

**Status: shipped and green on CI; unverified against real email.** CI at
`2bcaf8c`: 30 unit files / 374 tests, 193 e2e passed / 1 skipped in 10.4m across
24 spec files. The section below is section 7 of the readiness handoff **as it
stood at the moment the work merged**, moved here verbatim.

---

## 7 — The other half of auth: the code is built, the email is not

⛔ **NOTHING HERE IS VERIFIED AGAINST REAL EMAIL.** The code for phases 2 and 3
is **on `main` as of 2026-09-06** (#36, `32262b5`) and green on CI, but the reset
link's whole purpose is to ARRIVE, and delivery is phase 1 — dashboard SMTP,
which a checkout cannot do. Until step 1 lands, treat the reset half as unproven: e2e drives the
local Supabase stack, which accepts `resetPasswordForEmail` and mails into
Inbucket. **Production has never sent one of these.** Password SIGN-IN and
setting a password on an existing session need no email and were driven in a
browser (`e2e/24-password-auth.spec.ts`, 6 tests, green 2026-09-06).

| Step in a password flow | State |
|---|---|
| A commissioner **sets** a password for someone | ✅ `setStaffPassword` (`src/lib/actions/office.ts`, `requireCommissioner`, `admin.auth.admin.updateUserById`) |
| A user **sets their own** password | ✅ `/set-password` → `auth.ts:updateOwnPassword` (`auth.updateUser`), reached by `auth.ts:sendPasswordReset` → `/auth/confirm?next=/set-password`. ⚠️ The email leg is unproven — see above |
| A user **signs in** with it on production | ✅ `auth.ts:signInWithPassword`, second form on `/login`. ⚠️ Only useful to an account that HAS a password: `setStaffPassword` is the way to give the first one out without email |

**So magic link is not the primary way into the staff tools — it is the ONLY
way, with no fallback.** Supabase's built-in sender allows two emails an hour,
which a handful of simultaneous sign-ins exhausts; at that point every staff
member is locked out at once and the tool built to rescue them cannot be used.
That is the risk this item closes, and it is why phase 1 is worth doing alone.

⚠️ **Measured 2026-09-05, not read**: the auth-call inventory, both absences and
the `config.toml` scope below were produced by full-repository greps run with
two controls — one proving the grep shape finds a call that does exist
(`signInWithOtp` at `src/lib/actions/auth.ts:20`), one proving the missing
methods exist in the installed SDK (`@supabase/auth-js/GoTrueClient`). ⚠️ **No
probe was made against production.** Every claim about the production Supabase
project is a reading of the dashboard's documented behaviour, not an observation.

**Every `supabase.auth.*` call in `src/`** — so the next session need not grep:

```
2 getClaims            1 verifyOtp       1 signInWithPassword (devSignIn only)
2 admin.createUser     1 uid             1 signInWithOtp
1 admin.updateUserById 1 signOut         1 exchangeCodeForSession
1 admin.listUsers      1 admin.getUserById
```

`signInWithPassword` appears once, inside `devSignIn`, gated on
`ENABLE_DEV_LOGIN` — absent from every Vercel environment (item 1) and it should
stay absent. `auth.updateUser` and `resetPasswordForEmail` appear **nowhere**.

**What closes this, in order:**

1. **Custom SMTP (Resend).** ⛔ Dashboard work — cannot be done from a checkout.
   ⚠️ **The app needs no new env key.** Nothing in `src/` reads a Resend
   variable and nothing should: Supabase Auth sends these emails, so the API key
   belongs in the SUPABASE dashboard, not Vercel's.
   `vercel integration add resend/resend-email` is optional — it buys unified
   billing and puts `RESEND_API_KEY` somewhere the app will never read it.

   ⛔ **THERE IS NO DOMAIN TO VERIFY. THIS IS THE REAL BLOCKER, AND IT HAS A
   LEAD TIME NOTHING ELSE HERE HAS.** `vercel domains ls` returned **0 Domains**
   (measured 2026-09-05); production is `https://obhl.vercel.app`. `vercel.app`
   **cannot** be verified in Resend — it is not ours, and verification needs DNS
   records at the domain's authoritative nameservers. Someone has to **acquire a
   domain** before step (a) below is reachable at all.

   ✅ Two things make that smaller than it sounds. **The domain does not have to
   serve the app** — Resend needs records at the registrar, nothing requires
   moving off `obhl.vercel.app`, and mail can come from `noreply@<domain>` while
   every link still points at the vercel.app host; this is not a domain
   migration. And Resend's shared `onboarding@resend.dev` sender needs no DNS at
   all: it delivers **ONLY** to the address that owns the Resend account, which
   is enough to prove the (b) and (c) wiring and ⛔ **not** enough to unblock
   staff sign-in. Do not mark phase 1 done on it.

   a. **Verify a sending domain** in Resend, then create an API key. Unverified
      domains fail at send time, not at setup time.
   b. **Authentication → Emails → SMTP Settings**: host `smtp.resend.com`, port
      `465`, username **the literal string `resend`**, password the API key,
      sender an address at the domain from (a).
   c. **Authentication → Rate Limits**: raise "emails per hour" off its default
      of `2`. ⛔ Skipping this is the failure that looks like a bug in the app —
      links stop arriving for everyone at once, with nothing in the app's logs.
   d. Confirm Site URL and the redirect allow-list still name production, then
      send one real magic link and watch it arrive.
   ⛔ **THE ALLOW-LIST NEEDS A NEW ENTRY, AND ITS ABSENCE IS SILENT.** The reset
      link asks Supabase to return to `/auth/confirm?next=/set-password` — a
      QUERY STRING the magic link never had, and the allow-list is a list of
      exact URLs with wildcards. **Measured 2026-09-05** against the local
      stack: a `redirectTo` that is not listed returns **no error at all**, the
      mail still arrives, and its `redirect_to` is silently rewritten to the
      Site URL. So the person lands signed-in on `/` with the token spent, no
      way to finish, and nothing in the app's logs — while the action reports
      success. Locally this passes only because `config.toml` allows
      `http://localhost:3000/**`; production's list is unread from here. **Add a
      pattern covering `https://<prod host>/auth/confirm?**` (or the equivalent
      wildcard) before sending the first reset**, and add the preview pattern in
      the same visit — see the `NEXT_PUBLIC_SITE_URL` note below.
      ⚠️ There is no code fix for this: under PKCE `/auth/confirm` receives
      `?code=…` with **no `type`**, so it cannot recognise a recovery link and
      reuse the bare URL that is already listed. Measured the same day, by
      watching the navigation chain.
   e. **Read production's minimum password length and set it to 8**, while you
      are already in this dashboard. See the layering note under phase 2.
   f. **Read and record `secure_password_change` and the password-changed
      notification.** Both govern what a stolen session can do: with
      `secure_password_change` off, a session cookie alone — 7 days — is enough
      to set a password and keep access that outlives the session, and with the
      notification template off nobody is told. `config.toml` has
      `secure_password_change = false` and the `password_changed` template
      commented out, and ⛔ **both of those govern the LOCAL stack only** —
      production's values live in the dashboard and are **recorded nowhere**,
      exactly like the password length was. Turning them on is a judgement call;
      leaving them unrecorded is not.
   ⚠️ **Password sign-in has no throttle the app can see.** `signInWithPassword`
      counts nothing itself, and GoTrue's per-IP limit on `/token` sees the
      Next.js server's address rather than the caller's — every sign-in in the
      instance arrives from one IP. So the limit neither slows a guess-the-
      password run against one account nor keeps one attacker from spending the
      whole budget and locking everybody out of the password door. The magic link
      is unaffected and remains the way back in, which is why this is recorded
      rather than built: if it ever needs fixing, the fix is a per-email attempt
      count in a table, not a dashboard setting.

   ⚠️ **`NEXT_PUBLIC_SITE_URL` is set on Production ONLY** (`vercel env ls`,
   2026-09-05). `sendMagicLink` falls back to `http://localhost:3000` when it is
   absent, so a magic link requested from a PREVIEW deployment mails a localhost
   link. Production is unaffected. `vercel env add NEXT_PUBLIC_SITE_URL preview`
   is the whole fix, and an agent may not run it. ⛔ **That key alone is NOT
   sufficient** — Supabase's redirect allow-list must carry the preview pattern
   too, or the app builds a correct preview link that Supabase then refuses as
   unlisted. Both halves, or neither.

2. ✅ **BUILT (2026-09-05), unverified against real email.** A self-serve
   set/reset flow, riding on that SMTP. The hard part was already built: `/auth/confirm` (`src/app/auth/confirm/route.ts`) verifies a
   `token_hash` for ANY `EmailOtpType`, `recovery` included, sets the
   audit-session cookie, and redirects to a sanitised `next` path.

   ✅ **MERGED 2026-09-06 (#36)** — `resetPasswordForEmail` and `auth.updateUser`
   in `src/lib/actions/auth.ts`, the `src/app/set-password/` route, the shared
   `src/lib/auth/password.ts`, the `NO_LEAGUE_ACTIONS` entries below and
   `e2e/24-password-auth.spec.ts`. ⚠️ **The absences this section describes are
   history now** — it is kept as the record of what was decided and why, not as a
   to-do list; read the code for the present tense. ⛔ Still unproven end to end:
   no production email has been sent, because phase 1 is blocked on the domain.

   **Two calls and one route are missing — not one.** An earlier draft of this
   file said "a `resetPasswordForEmail` trigger", which undercounted it:

   - **The trigger.** An action calling `resetPasswordForEmail`. It must name
     its landing page in the email, because `/auth/confirm` redirects to `next`:
     ``resetPasswordForEmail(email, { redirectTo: `${base}/auth/confirm?next=/set-password` })``
   - **The landing.** A page calling `auth.updateUser({ password })` against the
     session `/auth/confirm` just established. ⛔ **`admin.updateUserById`
     cannot be reused for this** — it needs the admin client and sits behind
     `requireCommissioner`, and the whole point of the flow is that the person
     resetting their own password is not a commissioner.
   - **The route.** `find src/app` matches nothing on reset, recovery or
     password.

   ⚠️ **The 8-vs-6 password length is LAYERING, not a conflict — and it becomes
   one the moment this phase ships.** `MIN_PASSWORD = 8` (`office.ts`, chosen
   deliberately, with its reasoning in a comment) is checked *before* Supabase
   is called, so Supabase's floor never gets a say. A reset flow goes through
   Supabase Auth instead, so it would enforce Supabase's number: same account,
   two doors, two rules. ⛔ **`supabase/config.toml`'s `minimum_password_length
   = 6` is the stock scaffold default from the first commit and governs the
   LOCAL stack only** — there is no `supabase config push` in CI, `package.json`
   or `scripts/`. Production's real floor is whatever the dashboard says and is
   **recorded nowhere in this repository**, which is what step 1e is for.

   **What was built, and the decisions inside it.**

   | Piece | Where it landed |
   |---|---|
   | The reset trigger | `auth.ts:sendPasswordReset` — `resetPasswordForEmail(email, { redirectTo: `${base}/auth/confirm?next=/set-password` })`, same `(_prev, formData)` shape as `sendMagicLink`, same address-oracle-free reply |
   | The set-password page | `src/app/set-password/` — page + `SetPasswordForm`/`RequestResetForm`. **One URL is both halves**: with a session it sets the password, without one it offers the form that sends a fresh link, because a bookmark or a used link is the ordinary way to arrive |
   | The password field | `src/app/login/login-form.tsx:PasswordSignInForm`, a second form under the magic link, plus `auth.ts:signInWithPassword` (sets `audit_session`, lands on the picker like `devSignIn`) |
   | The floor | `src/lib/auth/password.ts` — `MIN_PASSWORD = 8` moved out of `office.ts`, now shared by both writers, with `password.test.ts` failing the build if either grows its own literal again |
   | The way back to it | `components/shared/account-cluster.tsx` — a `Password` link in every signed-in header, the ONLY in-app route to `/set-password`. It is also the recovery for the allow-list trap in step (d): someone dropped on `/` signed-in can still finish |
   | The audit entry | `auth.ts:updateOwnPassword` logs `set_own_password` under `entity_type: "office"`, with a sentence in `office-audit-notice.tsx`. ⚠️ "office" is not a claim that this is an office act — it is the only entity type whose entries are VISIBLE with a null league; anything else would be written correctly and hidden forever |

   ✅ **The 8-vs-6 layering is settled, and it did NOT need the dashboard.**
   Both password writers check 8 **before** Supabase is called, so Supabase's
   floor — 6 locally, unknown-and-unrecorded on production — never decides which
   rule an account gets. Step 1e is still worth doing, but the two doors can no
   longer disagree if it is never done.

   ⛔ **A FORM WHOSE ACTION IS A CLIENT FUNCTION EATS SUBMITS BEFORE HYDRATION,
   SILENTLY.** The first version of the login block put sign-in and reset in one
   form and chose between them in a client dispatcher, to avoid asking for the
   address twice. A Playwright click straight after `goto` reproduced the failure
   every time — the browser posts the form natively, there is no endpoint,
   /login reloads with the fields cleared and nothing said — while the same
   click after `networkidle` signed in fine. Both forms post to server actions
   now, and the reset trigger is a LINK to `/set-password` rather than a second
   button. ⚠️ Any test of these forms must wait for hydration or it is testing
   the race, not the page.

   ⛔ **NEITHER EMAIL ACTION REPORTS THE PROVIDER'S ERROR, AND THAT IS LOAD-
   BEARING.** Measured 2026-09-06 against the local stack: `signInWithOtp` with
   `shouldCreateUser: false` answers `422 otp_disabled` for an address with no
   account and succeeds for one with — **one request enumerates staff
   addresses** — and `resetPasswordForEmail` returns `200` either way but `429
   over_email_send_rate_limit` on a second request **only** for an address that
   exists, because the throttle it trips is per user. Both actions now answer
   with one sentence on every outcome, rate-limit advice included
   unconditionally, and log the real error server-side. ⚠️ An earlier version of
   this branch passed the message through and justified it in a comment with the
   claim that the limit was per project. That claim was false; a fresh-context
   review measured it.

   ✅ **THE WHOLE LOOP IS DRIVEN LOCALLY**, through a real message:
   `e2e/24-password-auth.spec.ts`'s last test requests a reset, reads it out of
   Mailpit, opens the link and finishes — covering every hop except production's
   SMTP. It skips itself when the local mail API is not answering rather than
   reddening a run over someone's environment.

   ⚠️ `league-guards.test.ts` went red exactly as this section predicted
   (`expected [ 'auth.ts:sendPasswordReset' ] to deeply equal []`). All three new
   actions are in `NO_LEAGUE_ACTIONS` with reasons; the file's baseline is
   **still 7 passed** — the entries are data, not cases, so the count does not
   move — and `e2e/02-auth.spec.ts`'s "no password field" test was
   rewritten — it asserted the absence this item exists to end, and now asserts
   the magic link SURVIVES alongside the field.

3. ✅ **BUILT (2026-09-05).** A password field on `/login`. ⚠️ Magic link stays
   the PRIMARY path — it is drawn first, and it is the only one that submits
   with no JavaScript. Removing it would replace one sole way in with a different
   sole way in, which is not progress — and the entire point of this item is not
   having a single one of those.

⛔ **1 IS THE ONLY THING LEFT, AND IT IS STILL THE GATE.** The reset flow's
email has never been sent by production, so do not tell anyone the reset link
works until step 1 is done and one real message has been watched to arrive. An
unverified sign-in path is worse than a missing one: it looks like a way back in,
right up to the moment someone needs it. Password sign-in itself is not in that
category — it needs no email — but until people have passwords, the only way to
give someone a first one is `setStaffPassword`.

**Runbook with the dashboard steps as a tickable checklist:**
<https://claude.ai/code/artifact/b92f802a-1a8f-4e0a-8599-3d601b9bc482>
