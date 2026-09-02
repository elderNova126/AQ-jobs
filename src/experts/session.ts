/// <reference lib="dom" />
// The readAuth() body below runs inside the page, so it needs DOM types
// (indexedDB). tsconfig targets Node, hence the file-local lib reference.
import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../config.js";
import { CHROME_UA } from "../ashby/client.js";
import { errMsg } from "../util.js";

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
  return chromium.launchPersistentContext(CONFIG.experts.profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent: CHROME_UA,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
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
): Promise<{ user: FirebaseUserLite | null; token: string | null }> {
  return page.evaluate(async () => {
    const readDb = (): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (v: Record<string, unknown> | null): void => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        setTimeout(() => done(null), 4000);
        try {
          const req = indexedDB.open("firebaseLocalStorageDb");
          req.onerror = () => done(null);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("firebaseLocalStorage")) return done(null);
            const tx = db.transaction("firebaseLocalStorage", "readonly");
            const all = tx.objectStore("firebaseLocalStorage").getAll();
            all.onerror = () => done(null);
            all.onsuccess = () => {
              const rows = (all.result ?? []) as { fbase_key?: string; value?: unknown }[];
              const hit = rows.find((r) => (r.fbase_key ?? "").startsWith("firebase:authUser:"));
              done((hit?.value as Record<string, unknown>) ?? null);
            };
          };
        } catch {
          done(null);
        }
      });

    const rec = await readDb();
    if (!rec) return { user: null, token: null };

    const email = (rec.email as string) ?? null;
    const displayName = (rec.displayName as string) ?? null;
    const sts = rec.stsTokenManager as
      | { accessToken?: string; expirationTime?: number }
      | undefined;

    // Only hand back a token that is actually still valid.
    const token =
      sts?.accessToken && (sts.expirationTime ?? 0) > Date.now() ? sts.accessToken : null;

    return { user: { email, displayName }, token };
  });
}

/** Current signed-in status, reading the persistent profile headlessly. */
export async function authStatus(force = false): Promise<AuthStatus> {
  if (!force && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.status;

  const base: AuthStatus = {
    signedIn: false,
    email: null,
    displayName: null,
    hasProfile: hasProfile(),
    checkedAt: new Date().toISOString(),
  };

  if (!base.hasProfile) {
    cached = { status: { ...base, detail: "not signed in yet" }, token: null, at: Date.now() };
    return cached.status;
  }

  let ctx: BrowserContext | null = null;
  try {
    ctx = await openProfile(true);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${CONFIG.experts.origin}/apply`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const { user, token } = await readAuth(page);
    const status: AuthStatus = {
      ...base,
      signedIn: Boolean(user?.email),
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      detail: user?.email
        ? token
          ? "session valid"
          : "signed in, token expired - it will refresh on next use"
        : "profile exists but is signed out; sign in again",
    };
    cached = { status, token, at: Date.now() };
    return status;
  } catch (err) {
    const status = { ...base, detail: `could not read session: ${errMsg(err)}` };
    cached = { status, token: null, at: Date.now() };
    return status;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

/** A usable Firebase ID token, or null when not signed in. */
export async function idToken(): Promise<string | null> {
  if (cached && cached.token && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  await authStatus(true);
  return cached?.token ?? null;
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
    let seen: { user: FirebaseUserLite | null; token: string | null } = {
      user: null,
      token: null,
    };

    while (Date.now() < deadline) {
      if (ctx.pages().length === 0) break; // user closed the window
      try {
        const active = ctx.pages().find((p) => p.url().includes("afterquery.com"));
        if (active) {
          seen = await readAuth(active);
          if (seen.user?.email) break;
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
      checkedAt: new Date().toISOString(),
      detail: "session saved to the local browser profile",
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
  await fs.promises.rm(CONFIG.experts.profileDir, { recursive: true, force: true });
}
