# AfterQuery Apply Agent

Scores every resume you upload against **all ~206 open AfterQuery roles across
both of their boards**, then applies for you — one role at a time, or in bulk
above a score threshold.

```
npm install
cp .env.example .env      # add OPENAI_API_KEY, keep AQ_DRY_RUN=1 for the first run
npm start                 # http://localhost:5173
```

---

## The two boards

| Board | Roles | What it is | Applying |
|---|---|---|---|
| **Ashby** | 33 | Full-time roles behind [afterquery.com/careers](https://www.afterquery.com/careers) | **Fully automated** end to end |
| **Experts** | ~173 | Contract/hourly roles on [experts.afterquery.com](https://experts.afterquery.com/apply) — $10–$200/hr, plus 6 talent pools | Scored and ranked here; **opens their site to apply** |

Both are scored against every resume and ranked in one list, so you see the
best-matching AfterQuery work regardless of which board it lives on. Rows carry
an `ashby` / `experts` badge and the board filter narrows to either.

Every row shows two buttons on both boards:

- **Ashby** — `Apply` runs the agent's fully automated submission; `Open ↗` opens
  the posting.
- **Experts** — `Apply ↗` opens that role's application form on
  experts.afterquery.com (signed in, ready to submit); `Open ↗` opens the job
  description.

Automated *submission* is deliberately limited to Ashby. Experts applications are
login-gated on their own site and filing one is irreversible on a live
marketplace, so the agent scores and ranks those roles and takes you straight
into the application, rather than blind-submitting something it cannot verify.

### Does signing in reveal more jobs?

**No** — worth stating plainly, because it looks like it does. The Experts
`/apply` page **paginates** (11 pages of ~16), which reads as a longer list
appearing after login. Their own client fetches the listing like this:

```js
authFetch("/api/jobs/listings", { optionalAuth: true })
```

All ~173 entries come back with no credentials at all. What signing in actually
gives you is `/home`, `/projects` (work you have been *assigned*, via
`/api/user/projects`), earnings, chat, surveys and credential upload — not more
listings.

That said, `optionalAuth` means the server *does* read a bearer token when one
is present, so a signed-in fetch could return a personalised set. The agent
passes your ID token whenever you are signed in and falls back to the anonymous
listing otherwise.

### The steady state: one capture, then headless forever

However you first sign in, the agent captures the session's **Firebase refresh
token** and stores it (`data/experts-auth.json`, 0600, gitignored). From then on
it mints fresh ID tokens directly from Google's secure-token endpoint —
**no browser, across restarts, for as long as the token stays valid (weeks).**
The `Use my Chrome` / sign-in routes below are really just ways to *capture* that
token once; after that, sign-in shows as `via a stored refresh token (headless)`.

If you already have a refresh token (e.g. from your browser's DevTools →
Application → IndexedDB → `firebaseLocalStorageDb` → `stsTokenManager.refreshToken`),
you can skip the browser entirely: click **Paste refresh token** and store it.
This is the same mechanism the companion `bot_o` project uses.

### Why the app can't see the login in your own browser

If you are signed in to AfterQuery in Chrome and then open `localhost:5173`, the
agent still says **not signed in**. That is correct, not a bug, and it's worth
understanding why because it drives the whole design:

- A page served from `localhost` **cannot** read `experts.afterquery.com`'s
  cookies or IndexedDB — that's the browser's same-origin policy.
- The session *is* on disk (`…/User Data/<profile>/IndexedDB/https_experts.afterquery.com_…`),
  but Chrome stores it as **snappy-compressed LevelDB** and holds the file open
  while running, so reading it off disk is unreliable — and copying the whole
  profile to get at it is exactly the pattern security tooling (rightly) flags as
  credential theft. This agent doesn't do that.

The clean way to reuse your existing login is to read it **through a browser
engine over CDP**. So there are three routes, all exposed as buttons in the UI:

| Route | Setup | Trade-off |
|---|---|---|
| **Use my Chrome** | Fully quit Chrome, click `Use my Chrome login` | Reuses your existing Google login; the agent reopens your real profile with a debug port and reads the live session (nothing copied). Must quit Chrome first — the debug port only opens at startup |
| **Attach to your Chrome** | Start Chrome yourself with `--remote-debugging-port=9222`, set `AQ_CHROME_CDP=http://localhost:9222` | Same idea, but you control the launch |
| **Sign in separately** (default) | Click `Sign in`; a real Chrome window opens for a one-time Google sign-in | One extra sign-in, then remembered forever in the agent's own profile |

The app detects your Chrome profiles and shows which one holds an AfterQuery
login, so `Use my Chrome login` targets the right profile automatically. Either
way all ~173 Experts roles are public, so nothing is blocked by being signed
out — signing in only lets the agent fetch the listing *as you*.

### How sign-in works, and why it works that way

Experts sign-in is **Google OAuth only** — Firebase Auth (project
`afterqueryai`) behind Firebase App Check with reCAPTCHA Enterprise. There is no
password form. That rules out two approaches that would otherwise be obvious:

- **Storing your Google password and scripting the login.** Google actively
  blocks automated sign-in and it would breach their terms. This agent never
  asks for, stores, or transmits a password.
- **Playwright's `storageState()`.** The Firebase JS SDK keeps its refresh token
  in **IndexedDB** (`firebaseLocalStorageDb`), and `storageState()` captures
  only cookies and localStorage — a saved state would silently come back signed
  out.

What actually fits is a **persistent Chrome profile**. Click `Sign in` in the
header and the agent opens a real browser window at their login page; *you*
complete Google sign-in (2FA, passkeys, consent screens all behave normally),
and Chrome's own profile directory keeps the session — IndexedDB included —
across restarts. Later runs read it headlessly and pull the Firebase ID token
straight off the page.

It launches your **real installed Chrome** (then Edge, then bundled Chromium as
a last resort), because Google frequently refuses OAuth from Playwright's
bundled Chromium with "this browser or app may not be secure". Override with
`AQ_BROWSER_CHANNEL`.

The profile lives in `data/experts-profile/` and is gitignored. `Sign out`
deletes it.

---

## What it does

1. **Syncs both boards** on every boot. A failure on one never loses the other.
2. **Parses each resume** you upload (PDF / DOCX / TXT / MD / RTF) to text, and
   auto-fills your name, email, LinkedIn, GitHub and phone from it.
3. **Scores that resume against every role**: an overall 0–100 plus skills /
   experience / domain / seniority sub-scores, a summary, strengths and gaps.
   Upload a second resume and both boards are re-scored for it; switch between
   resumes in the sidebar to compare.

   Because the two boards are ~206 roles, the free IDF heuristic ranks *all* of
   them instantly and only the top `AQ_SCORE_LIMIT` (default 80) get a real LLM
   assessment. Every row shows which method produced its score, so nothing is
   ever silently a guess. `AQ_SCORE_LIMIT=0` assesses all 206.
4. **Applies.** Per-row `Apply` on Ashby roles, or `Apply to N jobs (≥ 70)` at
   the top with a score filter. Each application opens the real Ashby page in
   Chrome, reads the live form, decides a value for every field, uploads your
   resume and submits.

---

## How applying actually works

AfterQuery's full-time board is **Ashby**. Every posting's `Apply now` goes to
`jobs.ashbyhq.com/AfterQuery/<jobId>/application`, a client-rendered app talking
to a private GraphQL endpoint. Getting this right required reading their board
rather than guessing at it:

- **The GraphQL operations are recovered from Ashby's own bundle.** Their job
  board ships pre-compiled GraphQL ASTs and introspection is disabled, so
  [`tools/extract-ashby-ops.ts`](tools/extract-ashby-ops.ts) downloads the Vite
  bundle, finds each `{kind:'Document',…}` literal, evaluates it and re-prints it
  with `graphql-js`. The result is [`src/ashby/gql-ops.ts`](src/ashby/gql-ops.ts)
  — byte-for-byte the operations a real applicant's browser sends. Re-run
  `npm run extract-ops` if Ashby ships a new build.

- **Each form read mints a fresh session.** `ApiJobPosting` returns a new
  `formRender.id` every call; that identifier *is* the session. Field values are
  written against it with `ApiSetFormValue` and the submit references it — no
  cookie, no login. A render is never reused across applications.

- **The form schema is read live, per job.** Nothing about the fields is
  hardcoded, because custom-field paths are per-posting UUIDs and AfterQuery can
  edit a form at any time. Today all 33 postings share the same six required
  fields (Name, Email, Resume, LinkedIn Profile, and two work-authorization
  questions); a seventh added tomorrow is handled the same day.

- **reCAPTCHA is real and enforced.** The submit mutation takes
  `recaptchaToken: String!`. A valid v3 token can only be produced by Google's
  script running on the `jobs.ashbyhq.com` origin, so the agent drives a real
  headless Chrome to the actual application page and calls
  `grecaptcha.execute(siteKey, {action:'job_apply'})` — exactly what a human
  applicant's browser does. There is no solver and no bypass. AfterQuery is not
  on Ashby's Enterprise reCAPTCHA flag, so the token is sent verbatim with no
  `ENT===` prefix.

- **Every GraphQL call is issued from inside that page.** Using the page's own
  `fetch` means origin, referer, cookies, UA and TLS fingerprint are the
  browser's, not a server-side imitation.

- **Resume upload has two non-obvious requirements.**
  `ApiCreateFileUploadHandle` returns a presigned S3 POST whose policy pins
  `Content-Type` — but Ashby does not include that key in the returned `fields`,
  so the client must append it or S3 answers `403 Policy Condition failed`. And
  `file` must be the last part in the multipart body.

- **It validates before submitting.** After writing every field, the agent
  checks Ashby's own view of the form for required-but-empty fields and aborts
  rather than firing a submit that would bounce.

Measured on the live board: **~5.5 s per application**, nine in ~26 s at the
default concurrency of 2. Field writes are spaced with short randomised pauses
so the request cadence looks like a person filling a form.

---

## Unexpected form fields

Any field the agent doesn't recognise goes to the model with the **job posting
and your resume** in context, batched into one call per application so a posting
that adds five questions still costs one round-trip.

Resolution order per field:

| Order | Source | Example |
|---|---|---|
| 1 | Your saved details | Name, Email, LinkedIn, GitHub, phone, location |
| 2 | The resume file | Any `File` field |
| 3 | Resume-derived profile | Work authorization the resume states outright |
| 4 | **The model**, job-match first | "Why this role?", "Describe a project", custom selects |
| 5 | Recorded default | A required Yes/No nothing else answered |

The prompt's first priority is presenting the strongest **honest** case for that
specific role, under hard rules: never state a falsehood, answer verifiable
facts only from resume evidence, and use an allowed option value verbatim on
choice fields. Every answer is stored with its source and a one-line rationale —
open any row's detail drawer to see exactly what was sent.

Values are coerced per Ashby field type (`String`, `Email`, `Url`, `Boolean`,
`Number`, `Currency`, `Date`, `ValueSelect`, `MultiValueSelect`, `Location`,
`LongText`, …) because `setFormValue` takes an untyped JSON scalar: a wrong
shape is accepted on the wire and only fails at submit. Choice fields are
matched back to an exact allowed value, so a chatty "Yes, I am authorized"
becomes `Yes` and an unmatchable answer becomes `null` rather than a guess.

**Legal status is never guessed.** Work-authorization, sponsorship and clearance
questions are answered only from your explicit setting or clear resume evidence.
If neither exists the application *fails* with a message naming the control to
set, because answering "yes, I need visa sponsorship" on your behalf when it
isn't true would be a misrepresentation on a real application. Set both
dropdowns under **Applicant details → Optional & work authorization** once.

---

## The UI

- **Resumes** — drag in several. Star one as primary; the first upload is
  starred automatically. Deleting a resume removes its scores.
- **Applicant details** — per resume, so each can carry its own identity.
  `Apply` stays disabled until First name, Last name, Email, LinkedIn and GitHub
  are all set; the chip tells you what's missing.
- **Job matches** — one ranked list across both boards, filterable by text,
  department, board and score. Click a title for the full posting, score
  breakdown, strengths, gaps, the extra credentials an Experts role wants, and
  the exact fields sent on the last application.
- **Bulk apply** — set a minimum score, optionally skip roles already applied
  to, and confirm the list before anything is submitted. Ashby-only, and the
  button says so.
- **Activity** — live progress over SSE, step by step, per job.

---

## Token usage

The header shows a live **token pill** (e.g. `13.2k tok · ~$0.08`) — exact input/
output tokens used this session (hover for the breakdown, including cache hits),
plus a cost *estimate*. Token counts are exact; the dollar figure uses the
per-1M rates `AQ_PRICE_IN` / `AQ_PRICE_OUT` in `.env` (defaults ballpark gpt-5).

Scoring is the main spend: ~$0.02/role on gpt-5, so scoring one resume against
the default top-80 is roughly $1–2. Lower `AQ_SCORE_LIMIT` (or `AQ_EFFORT`) to
spend less; the heuristic still ranks every role for free.

## If a submission is flagged as spam

Ashby scores the reCAPTCHA v3 token and flags low scores as "possible spam".
Score is about how human the browser looks, so the agent uses **real Chrome**, a
**warm persistent profile** (`data/apply-profile/`, reused), and human-like
mouse/scroll/dwell before minting each token, and it **retries once** with a
fresh token on a spam flag.

The single biggest lever is **`AQ_HEADFUL=1`** — a visible browser window scores
far higher than any headless mode. If you see spam flags with `AQ_DRY_RUN=0`,
set `AQ_HEADFUL=1` and re-apply.

## Safety

- `AQ_DRY_RUN=1` runs everything — browser, form read, answers, resume upload,
  field writes, validation — and stops before the submit mutation. Nothing
  reaches AfterQuery. **Use it for your first run.**
- Applications are idempotent by default: a bulk run skips any role already
  submitted with that resume. Per-row `Apply` becomes `Re-apply` and asks first.
- One apply run at a time, and one sign-in window at a time, server-side.
- Data is local: `data/store.json`, your resume files under `data/resumes/`, and
  the Experts browser profile under `data/experts-profile/`. All gitignored.

Without an API key the agent still runs: scoring falls back to the IDF-weighted
keyword heuristic (labelled `heuristic` in the UI) and unrecognised questions
cannot be answered, so applications with novel fields fail rather than submit
something made up.

**Either LLM provider works.** Whichever key is present is used, preferring
OpenAI. The split lives entirely in [`src/llm.ts`](src/llm.ts); nothing
downstream knows which model answered. Prompt caching is exploited on both — the
resume is the stable prefix, so scoring one resume against the shortlist pays
for the resume tokens once.

---

## Configuration

All optional except the API key — see [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Enables real scoring and question answering |
| `ANTHROPIC_API_KEY` | — | Alternative provider; either key works |
| `AQ_LLM_PROVIDER` | `auto` | `openai`, `anthropic`, or auto-detect from the keys |
| `AQ_MODEL` | provider default | `gpt-5` / `claude-opus-5`. On a bad value the server prints the models your key *can* use |
| `AQ_SCORE_LIMIT` | `80` | Roles given a real LLM assessment per resume; `0` = all |
| `AQ_EFFORT` | `low` | OpenAI reasoning effort for scoring; profile/answers force `medium` |
| `AQ_SCORE_CONCURRENCY` | `6` | Parallel LLM calls while scoring |
| `AQ_DRY_RUN` | `0` | `1` = fill and validate but never submit |
| `AQ_APPLY_CONCURRENCY` | `2` | Parallel browser workers in a bulk run |
| `AQ_HEADFUL` | `0` | `1` = show the Chrome window while applying |
| `AQ_EXPERTS` | `1` | `0` skips the Experts board entirely |
| `AQ_FIREBASE_API_KEY` | AfterQuery's | Public Firebase key for the headless refresh-token exchange |
| `AQ_USE_MY_CHROME` | `0` | `1` reads your login from your own Chrome profile (also a UI button) |
| `AQ_CHROME_PROFILE` | auto | Which Chrome profile holds your login, e.g. `Default`, `Profile 1` |
| `AQ_CHROME_PATH` / `AQ_CHROME_USER_DATA_DIR` | auto | Overrides if Chrome is in a non-standard location |
| `AQ_CDP_PORT` | `9222` | Debug port the agent opens on your Chrome |
| `AQ_CHROME_CDP` | — | Attach to a Chrome you started yourself with `--remote-debugging-port` |
| `AQ_BROWSER_CHANNEL` | auto | Browser for the separate-sign-in window: `chrome`, `msedge`, or blank |
| `AQ_SIGNIN_TIMEOUT_MS` | `300000` | How long the sign-in window waits for you |
| `PORT` | `5173` | HTTP port |

---

## Layout

```
src/
  server.ts            Express API + SSE progress stream
  config.ts            .env loading, board + reCAPTCHA constants
  store.ts             atomic JSON persistence
  scoring.ts           LLM scoring + IDF-weighted heuristic prescreen
  llm.ts               OpenAI/Anthropic split, structured output, caching
  types.ts             Ashby wire shapes + domain model
  ashby/
    gql-ops.ts         GENERATED - operations recovered from Ashby's bundle
    client.ts          board API, GraphQL transport, resume upload
  experts/
    client.ts          Experts listings -> Job, with optional bearer token
    session.ts         auth status/capture across every route + Firebase ID token
    token-store.ts     headless refresh-token -> ID token exchange (the steady state)
    chrome.ts          "Use my Chrome": profile discovery, launch, CDP read
  resume/
    extract.ts         PDF/DOCX/TXT -> text, identity scraping
    profile.ts         resume -> structured profile
  apply/
    browser.ts         Chrome pool, reCAPTCHA, in-page GraphQL
    fill.ts            field resolution + per-type coercion
    engine.ts          per-job and bulk orchestration
public/                single-page UI (no build step)
tools/
  extract-ashby-ops.ts regenerate gql-ops.ts from the live bundle
  selftest.ts          38 checks incl. the __name-shim + discovery guards
```

### A note on in-page code

Anything passed to `page.evaluate` must avoid **named inner functions**. tsx's
esbuild rewrites `const f = () => {}` into `__name(() => {}, "f")`, and that
helper does not exist inside the browser — the call dies with
`ReferenceError: __name is not defined`. This bit once: session detection failed
that way and surfaced as a permanent "not signed in" rather than an error.
`NAME_SHIM` in `src/util.ts` is installed into every context the agent owns, and
`readAuth` is additionally written flat so it also works in a CDP-attached
browser where we install nothing.

```
npm run typecheck
npm run selftest        # includes live checks against both AfterQuery boards
npm run extract-ops     # after an Ashby release
```
