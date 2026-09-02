/// <reference lib="dom" />
// The readAuth() body below runs inside the page, so it needs DOM types
// (indexedDB). tsconfig targets Node, hence the file-local lib reference.
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../config.js";
import { CHROME_UA } from "../ashby/client.js";
import { NAME_SHIM, errMsg } from "../util.js";
import { openUserBrowser, readSessionFromBrowser } from "./chrome.js";
import {
  clearTokenStore,
  decodeJwt,
  freshToken,
  hasUsableToken,
  ingestIdToken,
  ingestRefreshToken,
  parsePastedCredential,
  tokenStatus,
} from "./token-store.js";

/**
 * Signed-in state for experts.afterquery.com.
 *
 * Why it works the way it does
 * ----------------------------
 * Their sign-in is **Google OAuth only** - Firebase Auth (project
 * `afterqueryai`) behind Firebase App Check with reCAPTCHA Enterprise. There is
 * no password form to post to. That rules out two approaches that would
 * otherwise be obvious:
 *
 *  - Storing the user's Google credentials and scripting the login. Google
 *    actively blocks automated sign-in and it would breach their terms. We
 *    never ask for, store, or transmit a password.
 *  - Playwright's `storageState()`. The Firebase JS SDK keeps its refresh token
 *    in **IndexedDB** (`firebaseLocalStorageDb`), and `storageState()` captures
 *    only cookies and localStorage - so a saved state would silently come back
 *    signed out.
 *
 * What is left is the approach that actually fits: a **persistent browser
 * profile**. We open a real Chrome window at their login page, the user
 * completes Google sign-in themselves (2FA, passkeys, consent screens all work
 * normally), and Chrome's own profile directory keeps the session - IndexedDB
 * included - across restarts. Later runs reuse that profile headlessly.
 *
 * With a live session we can read the Firebase ID token straight off the page
 * and attach it to their `optionalAuth` endpoints.
 */

export interface AuthStatus {
  signedIn: boolean;
  email: string | null;
  displayName: string | null;
  /** True when a profile directory exists, whether or not it is still valid. */
  hasProfile: boolean;
  /** Where the answer came from, so the UI can explain itself. */
  via: "refresh-token" | "my-chrome" | "your-browser" | "agent-profile" | null;
  /** Why we are not signed in, when we are not. */
  reason: "ok" | "never-signed-in" | "signed-out" | "error";
  checkedAt: string;
  detail?: string;
}

/** Shape Firebase exposes on `getAuth().currentUser`. */
interface FirebaseUserLite {
  email: string | null;
  displayName: string | null;
}

let cached: { status: AuthStatus; token: string | null; at: number } | null = null;
/** ID tokens are ~1h; re-read well inside that. */
const TOKEN_TTL_MS = 20 * 60 * 1000;

export const hasProfile = (): boolean =>
  fs.existsSync(CONFIG.experts.profileDir) &&
  fs.readdirSync(CONFIG.experts.profileDir).length > 0;

/**
 * Open the persistent profile. `headless: false` is required for the initial
 * interactive sign-in; later reads can run headless.
 */
async function openProfile(headless: boolean): Promise<BrowserContext> {
  fs.mkdirSync(CONFIG.experts.profileDir, { recursive: true });

  const base = {
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  };

  /**
   * Prefer a real installed browser over Playwright's bundled Chromium.
   *
   * Google refuses OAuth sign-in from browsers it considers insecure or
   * automated, and bundled Chromium is frequently rejected with "this browser
   * or app may not be secure". Real Chrome (or Edge) with its own profile
   * directory gets through, which is the difference between the user being able
   * to sign in at all and not.
   */
  const channels = CONFIG.experts.browserChannel
    ? [CONFIG.experts.browserChannel]
    : ["chrome", "msedge"];

  let lastErr: unknown;
  for (const channel of channels) {
    try {
      const ctx = await chromium.launchPersistentContext(CONFIG.experts.profileDir, {
        ...base,
        channel,
      });
      await ctx.addInitScript(NAME_SHIM);
      return ctx;
    } catch (err) {
      lastErr = err;
    }
  }

  // No system browser available - bundled Chromium still works for reading an
  // existing session, it is only interactive Google sign-in that may be refused.
  try {
    const ctx = await chromium.launchPersistentContext(CONFIG.experts.profileDir, {
      ...base,
      userAgent: CHROME_UA,
    });
    await ctx.addInitScript(NAME_SHIM);
    return ctx;
  } catch {
    throw new Error(
      `could not launch a browser for the Experts session: ${errMsg(lastErr)}`,
    );
  }
}

/**
 * Read the Firebase auth state out of a loaded Experts page.
 *
 * The app keeps its auth instance inside the module graph rather than on
 * `window`, so there is nothing to call. Instead we read the record Firebase
 * itself persists in IndexedDB (`firebaseLocalStorageDb` ->
 * `firebase:authUser:*`) - the same source the SDK rehydrates from on load, so
 * it is authoritative rather than a guess.
 */
async function readAuth(
  page: Page,
): Promise<{ user: FirebaseUserLite | null; token: string | null; refreshToken: string | null }> {
  // Written as a flat body with no inner named functions on purpose. esbuild
  // rewrites `const f = () => {}` into `__name(() => {}, "f")`, and that helper
  // does not exist inside the page - see NAME_SHIM in util.ts. Keeping this
  // body free of named inner functions means it works even in a browser we do
  // not control (a CDP-attached Chrome, where we do not install the shim). We
  // still bootstrap the shim first (as a raw string, immune to the transform)
  // so this is robust even if the body grows a named const later.
  await page.evaluate(NAME_SHIM);
  return page.evaluate(async () => {
    const rec = await new Promise<Record<string, unknown> | null>((resolve) => {
      let settled = false;
      const finish = (v: Record<string, unknown> | null): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      setTimeout(() => finish(null), 4000);
      try {
        const req = indexedDB.open("firebaseLocalStorageDb");
        req.onerror = () => finish(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("firebaseLocalStorage")) return finish(null);
          const all = db
            .transaction("firebaseLocalStorage", "readonly")
            .objectStore("firebaseLocalStorage")
            .getAll();
          all.onerror = () => finish(null);
          all.onsuccess = () => {
            const rows = (all.result ?? []) as { fbase_key?: string; value?: unknown }[];
            let hit: Record<string, unknown> | null = null;
            for (const row of rows) {
              if ((row.fbase_key ?? "").startsWith("firebase:authUser:")) {
                hit = (row.value as Record<string, unknown>) ?? null;
                break;
              }
            }
            finish(hit);
          };
        };
      } catch {
        finish(null);
      }
    });

    if (!rec) return { user: null, token: null, refreshToken: null };

    const sts = rec.stsTokenManager as
      | { accessToken?: string; refreshToken?: string; expirationTime?: number }
      | undefined;

    return {
      user: {
        email: (rec.email as string) ?? null,
        displayName: (rec.displayName as string) ?? null,
      },
      // Only hand back an ID token that is actually still valid...
      token:
        sts?.accessToken && (sts.expirationTime ?? 0) > Date.now() ? sts.accessToken : null,
      // ...but always grab the refresh token: it is long-lived and lets us mint
      // fresh ID tokens headlessly from here on, with no browser.
      refreshToken: sts?.refreshToken ?? null,
    };
  });
}

/**
 * Hand a captured refresh token to the headless token store.
 *
 * This is the payoff of every browser read: once we have the refresh token, the
 * agent never needs a browser again to stay signed in - it mints ID tokens
 * directly from Google's secure-token endpoint.
 */
async function captureRefreshToken(refreshToken: string | null): Promise<void> {
  if (!refreshToken) return;
  try {
    await ingestRefreshToken(refreshToken, CONFIG.experts.firebaseApiKey);
  } catch (err) {
    console.warn(`[experts] could not store refresh token: ${errMsg(err)}`);
  }
}

/**
 * Attach to a Chrome the user is already signed into, if they configured one.
 *
 * Returns null when no CDP endpoint is set or it is unreachable, so the caller
 * falls back to the agent's own profile.
 */
async function connectUserBrowser(): Promise<{
  ctx: BrowserContext;
  disconnect: () => Promise<void>;
} | null> {
  const url = CONFIG.experts.chromeCdpUrl;
  if (!url) return null;
  try {
    const browser = await chromium.connectOverCDP(url, { timeout: 5000 });
    const ctx = browser.contexts()[0];
    if (!ctx) {
      await browser.close().catch(() => {});
      return null;
    }
    // Disconnect only - never close a browser the user owns.
    return { ctx, disconnect: async () => void (await browser.close().catch(() => {})) };
  } catch {
    return null;
  }
}

/**
 * Find (or open) a page on the Experts origin so IndexedDB is reachable.
 *
 * In an attached browser the user may already have the tab open, in which case
 * we read it in place rather than navigating anything of theirs.
 */
async function expertsPage(ctx: BrowserContext, navigate: boolean): Promise<Page> {
  for (const p of ctx.pages()) {
    if (p.url().startsWith(CONFIG.experts.origin)) return p;
  }
  const page = await ctx.newPage();
  if (navigate) {
    await page.goto(`${CONFIG.experts.origin}/apply`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }
  return page;
}

/**
 * Current signed-in status.
 *
 * Tries, in order:
 *   1. a Chrome you are already signed into, if AQ_CHROME_CDP is configured;
 *   2. the agent's own persistent profile.
 *
 * It deliberately does NOT try to read the browser you are viewing the UI in.
 * A page served from localhost cannot read experts.afterquery.com's cookies or
 * IndexedDB - that is the same-origin policy and there is no way around it - so
 * being logged in there is invisible to this process by design.
 */
export async function authStatus(force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.status;

  const base: AuthStatus = {
    signedIn: false,
    email: null,
    displayName: null,
    hasProfile: hasProfile(),
    via: null,
    reason: "never-signed-in",
    checkedAt: new Date().toISOString(),
  };

  // 0. Headless refresh-token: if we have ever captured a refresh token, we can
  //    mint a fresh ID token with no browser at all. This is the steady state -
  //    once captured (from Chrome or a paste), sign-in survives restarts for as
  //    long as the refresh token is valid, and we never launch a browser again.
  if (hasUsableToken()) {
    const token = await freshToken();
    const ts = tokenStatus();
    const status: AuthStatus = {
      ...base,
      via: "refresh-token",
      signedIn: Boolean(token),
      email: ts.email,
      displayName: null,
      reason: token ? "ok" : ts.lastError ? "error" : "signed-out",
      detail: token
        ? "signed in headlessly via a stored refresh token (no browser needed)"
        : ts.lastError
          ? `stored refresh token failed: ${ts.lastError} - re-capture it`
          : "stored refresh token is no longer valid - re-capture it",
    };
    cached = { status, token, at: Date.now() };
    // A valid headless token is the ideal state; only fall through to browser
    // routes when it has genuinely stopped working.
    if (token) return status;
  }

  // 0b. "Use my Chrome": launch the user's own Chrome profile and read the live
  //    session over CDP. Used to CAPTURE the refresh token the first time.
  if (CONFIG.experts.useMyChrome || CONFIG.experts.chromeCdpUrl) {
    let handle: Awaited<ReturnType<typeof openUserBrowser>> | null = null;
    try {
      handle = await openUserBrowser();
      const { email, displayName, token, refreshToken } = await readSessionFromBrowser(
        handle.browser,
      );
      // Capture the refresh token so subsequent runs are fully headless.
      if (email) await captureRefreshToken(refreshToken);
      const status: AuthStatus = {
        ...base,
        via: "my-chrome",
        signedIn: Boolean(email),
        email: email ?? null,
        displayName: displayName ?? null,
        reason: email ? "ok" : "signed-out",
        detail: email
          ? refreshToken
            ? "read from your Chrome and stored for headless refresh (no browser needed next time)"
            : "read live from your own Chrome"
          : "opened your Chrome, but that profile is not signed in to AfterQuery Experts",
      };
      cached = { status, token, at: Date.now() };
      return status;
    } catch (err) {
      const status: AuthStatus = {
        ...base,
        via: "my-chrome",
        reason: "error",
        detail: errMsg(err),
      };
      cached = { status, token: null, at: Date.now() };
      return status;
    } finally {
      await handle?.release();
    }
  }

  // 1. A browser the user is already signed into (legacy manual CDP path).
  const attached = await connectUserBrowser();
  if (attached) {
    try {
      const page = await expertsPage(attached.ctx, true);
      const { user, token, refreshToken } = await readAuth(page);
      if (user?.email) await captureRefreshToken(refreshToken);
      const status: AuthStatus = {
        ...base,
        via: "your-browser",
        signedIn: Boolean(user?.email),
        email: user?.email ?? null,
        displayName: user?.displayName ?? null,
        reason: user?.email ? "ok" : "signed-out",
        detail: user?.email
          ? `read from your attached Chrome (${CONFIG.experts.chromeCdpUrl})`
          : "attached to your Chrome, but it is not signed in to AfterQuery Experts",
      };
      cached = { status, token, at: Date.now() };
      return status;
    } catch (err) {
      cached = {
        status: {
          ...base,
          via: "your-browser",
          reason: "error",
          detail: `attached to your Chrome but could not read the session: ${errMsg(err)}`,
        },
        token: null,
        at: Date.now(),
      };
      return cached.status;
    } finally {
      await attached.disconnect();
    }
  }

  // 2. The agent's own profile. Nothing to read until it has been signed in.
  if (!base.hasProfile) {
    cached = {
      status: {
        ...base,
        reason: "never-signed-in",
        detail:
          "the agent has its own browser profile and has not been signed in yet - " +
          "click Sign in (your own browser's login cannot be read from localhost)",
      },
      token: null,
      at: Date.now(),
    };
    return cached.status;
  }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await openProfile(true);
    const page = await expertsPage(ctx, true);
    const { user, token, refreshToken } = await readAuth(page);
    if (user?.email) await captureRefreshToken(refreshToken);
    const status: AuthStatus = {
      ...base,
      via: "agent-profile",
      signedIn: Boolean(user?.email),
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      reason: user?.email ? "ok" : "signed-out",
      detail: user?.email
        ? token
          ? "signed in, from the agent's own browser profile"
          : "signed in; the token expired and will refresh on next use"
        : "the agent's profile exists but is signed out - sign in again",
    };
    cached = { status, token, at: Date.now() };
    return status;
  } catch (err) {
    const status: AuthStatus = {
      ...base,
      via: "agent-profile",
      reason: "error",
      detail: `could not read the agent's session: ${errMsg(err)}`,
    };
    cached = { status, token: null, at: Date.now() };
    return status;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/**
 * A usable Firebase ID token, or null when not signed in.
 *
 * Headless first: if a refresh token is stored, mint from it directly - no
 * browser, no cache-staleness games. Only if that is absent do we fall back to
 * reading a browser (which also captures a refresh token for next time).
 */
export async function idToken(): Promise<string | null> {
  if (hasUsableToken()) {
    const t = await freshToken();
    if (t) return t;
  }
  if (cached && cached.token && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  await authStatus(true);
  return cached?.token ?? null;
}

/**
 * The current signed-in identity for building an Experts submission body:
 * a fresh ID token plus the uid/email decoded from it.
 */
export async function sessionInfo(): Promise<
  { token: string; uid: string; email: string | null } | null
> {
  const token = await idToken();
  if (!token) return null;
  const claims = decodeJwt(token);
  const uid = claims.user_id ?? claims.sub ?? "";
  if (!uid) return null;
  return { token, uid, email: claims.email ?? null };
}

/**
 * Sign in from whatever the user pasted (the zero-browser route).
 *
 * Accepts a refresh token, an accessToken (ID token), or the whole
 * `stsTokenManager` / auth record object. A refresh token gives a lasting,
 * self-renewing session; a bare accessToken signs in only until it expires
 * (~1h), so we say so and nudge toward the refresh token.
 */
export async function ingestPastedCredential(raw: string, apiKey?: string): Promise<AuthStatus> {
  cached = null;
  const parsed = parsePastedCredential(raw);

  // Prefer the refresh token - it is the only path to a durable session.
  if (parsed.refreshToken) {
    const res = await ingestRefreshToken(parsed.refreshToken, apiKey);
    const status = await authStatus(true);
    if (!res.ok && status.reason !== "ok") status.detail = res.error ?? status.detail;
    return status;
  }

  // Only an accessToken was pasted: usable now, but temporary.
  if (parsed.idToken) {
    const res = ingestIdToken(parsed.idToken);
    if (!res.ok) {
      return {
        signedIn: false,
        email: null,
        displayName: null,
        hasProfile: hasProfile(),
        via: "refresh-token",
        reason: "error",
        checkedAt: new Date().toISOString(),
        detail: res.error,
      };
    }
    const status = await authStatus(true);
    const mins = res.exp ? Math.max(0, Math.round((res.exp * 1000 - Date.now()) / 60000)) : 0;
    status.detail =
      `signed in with a pasted access token — expires in ~${mins} min and cannot ` +
      `renew itself. For a lasting session, paste the refreshToken instead.`;
    return status;
  }

  return {
    signedIn: false,
    email: null,
    displayName: null,
    hasProfile: hasProfile(),
    via: "refresh-token",
    reason: "error",
    checkedAt: new Date().toISOString(),
    detail: "could not find a token in what you pasted",
  };
}

/**
 * Open a real Chrome window on the Experts login page and wait for the user to
 * finish signing in with Google.
 *
 * Deliberately hands control to the person: we navigate to the login page and
 * then watch for auth state to appear. We never type into Google's forms.
 */
export async function signInInteractive(
  onStep?: (s: string) => void,
): Promise<AuthStatus> {
  const step = (s: string): void => onStep?.(s);
  let ctx: BrowserContext | null = null;
  try {
    step("opening a browser window for Google sign-in");
    ctx = await openProfile(false);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${CONFIG.experts.origin}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    step("waiting for you to sign in with Google (complete it in the window)");
    const deadline = Date.now() + CONFIG.experts.signInTimeoutMs;
    let seen: {
      user: FirebaseUserLite | null;
      token: string | null;
      refreshToken: string | null;
    } = { user: null, token: null, refreshToken: null };

    while (Date.now() < deadline) {
      if (ctx.pages().length === 0) break; // user closed the window
      try {
        const active = ctx.pages().find((p) => p.url().includes("afterquery.com"));
        if (active) {
          seen = await readAuth(active);
          if (seen.user?.email) {
            await captureRefreshToken(seen.refreshToken);
            break;
          }
        }
      } catch {
        /* mid-navigation; try again */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    cached = null;
    if (!seen.user?.email) {
      return {
        signedIn: false,
        email: null,
        displayName: null,
        hasProfile: hasProfile(),
        via: "agent-profile",
        reason: "signed-out",
        checkedAt: new Date().toISOString(),
        detail: "sign-in was not completed before the window closed or timed out",
      };
    }

    step(`signed in as ${seen.user.email}`);
    const status: AuthStatus = {
      signedIn: true,
      email: seen.user.email,
      displayName: seen.user.displayName,
      hasProfile: true,
      via: "agent-profile",
      reason: "ok",
      checkedAt: new Date().toISOString(),
      detail: "session saved to the agent's own browser profile",
    };
    cached = { status, token: seen.token, at: Date.now() };
    return status;
  } finally {
    // Closing the context is what flushes Chrome's profile to disk.
    await ctx?.close().catch(() => {});
  }
}

/** Forget the session by deleting the browser profile. */
export async function signOut(): Promise<void> {
  cached = null;
  clearTokenStore();
  await fs.promises.rm(CONFIG.experts.profileDir, { recursive: true, force: true });
}
