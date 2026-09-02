import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { CONFIG } from "../config.js";
import { NAME_SHIM, errMsg, sleep } from "../util.js";

/**
 * "Use my Chrome" — read the AfterQuery Experts login from your own Chrome.
 *
 * This is the only clean way to reuse an existing Google sign-in:
 *  - a page on localhost cannot read experts.afterquery.com's session (same
 *    origin policy);
 *  - the on-disk session is snappy-compressed LevelDB that only decodes through
 *    a browser engine, and Chrome holds it open while running;
 *  - so we launch your REAL Chrome profile with a debug port and read the live
 *    session over CDP. Nothing is copied and the token is always current.
 *
 * The one constraint is Chrome's: the remote-debugging port can only be opened
 * at startup and will not bind if that profile's Chrome is already running, so
 * the target profile must be closed first. We detect that and say so.
 */

/* --------------------------- discovery --------------------------- */

export function findChromePath(): string | null {
  if (CONFIG.experts.chromePath && fs.existsSync(CONFIG.experts.chromePath)) {
    return CONFIG.experts.chromePath;
  }
  const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

  const candidates =
    process.platform === "win32"
      ? [
          path.join(pf, "Google/Chrome/Application/chrome.exe"),
          path.join(pf86, "Google/Chrome/Application/chrome.exe"),
          path.join(local, "Google/Chrome/Application/chrome.exe"),
          path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
          path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];

  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The Chrome/Edge "User Data" root for the current OS. */
export function chromeUserDataDir(): string | null {
  // Explicit override for non-standard installs (and used by the self-test).
  if (CONFIG.experts.userDataDir) {
    return fs.existsSync(CONFIG.experts.userDataDir) ? CONFIG.experts.userDataDir : null;
  }
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(local, "Google/Chrome/User Data"),
          path.join(local, "Microsoft/Edge/User Data"),
        ]
      : process.platform === "darwin"
        ? [
            path.join(home, "Library/Application Support/Google/Chrome"),
            path.join(home, "Library/Application Support/Microsoft Edge"),
          ]
        : [path.join(home, ".config/google-chrome"), path.join(home, ".config/chromium")];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export interface ChromeProfileInfo {
  dir: string;
  /** The human name from Chrome's Local State, e.g. "Phan (work)". */
  name: string;
  /** True if this profile has stored an experts.afterquery.com session. */
  hasExpertsLogin: boolean;
  /** mtime of the Firebase IndexedDB, our freshness hint. */
  lastSeen: number | null;
}

/**
 * Enumerate Chrome profiles, flagging which ones have an AfterQuery Experts
 * login on disk. We never read the session here — only whether the IndexedDB
 * directory exists and when it was last written — so the user can be shown a
 * sensible default profile to use.
 */
export function listChromeProfiles(userDataDir: string): ChromeProfileInfo[] {
  const names = readProfileNames(userDataDir);
  const out: ChromeProfileInfo[] = [];
  for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== "Default" && !/^Profile \d+$/.test(entry.name)) continue;
    const idb = path.join(
      userDataDir,
      entry.name,
      "IndexedDB",
      "https_experts.afterquery.com_0.indexeddb.leveldb",
    );
    let lastSeen: number | null = null;
    if (fs.existsSync(idb)) {
      let newest = 0;
      for (const f of fs.readdirSync(idb)) {
        try {
          const m = fs.statSync(path.join(idb, f)).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* ignore */
        }
      }
      lastSeen = newest || null;
    }
    out.push({
      dir: entry.name,
      name: names[entry.name] ?? entry.name,
      hasExpertsLogin: fs.existsSync(idb),
      lastSeen,
    });
  }
  // Profiles with a login first, most-recently-used within that.
  return out.sort((a, b) => {
    if (a.hasExpertsLogin !== b.hasExpertsLogin) return a.hasExpertsLogin ? -1 : 1;
    return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
  });
}

function readProfileNames(userDataDir: string): Record<string, string> {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"),
    ) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    const cache = state.profile?.info_cache ?? {};
    const map: Record<string, string> = {};
    for (const [dir, info] of Object.entries(cache)) if (info.name) map[dir] = info.name;
    return map;
  } catch {
    return {};
  }
}

/** Pick the profile most likely to hold the AfterQuery login. */
export function pickProfile(userDataDir: string): ChromeProfileInfo | null {
  if (CONFIG.experts.chromeProfile) {
    const want = listChromeProfiles(userDataDir).find(
      (p) => p.dir === CONFIG.experts.chromeProfile,
    );
    if (want) return want;
  }
  const profiles = listChromeProfiles(userDataDir);
  return profiles.find((p) => p.hasExpertsLogin) ?? profiles[0] ?? null;
}

/* --------------------------- launch + attach --------------------------- */

const debugEndpoint = (port: number): string => `http://127.0.0.1:${port}`;

async function debugPortAlive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`${debugEndpoint(port)}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface UserBrowser {
  browser: Browser;
  /** Disconnect only — never kill a Chrome the user owns. */
  release: () => Promise<void>;
}

/**
 * Get a CDP-connected handle to the user's Chrome, launching it if needed.
 *
 * Order:
 *   1. An explicit AQ_CHROME_CDP endpoint, or our own debug port already up.
 *   2. Launch the user's real Chrome profile with the debug port.
 *
 * Throws a message the UI can show verbatim when the target profile's Chrome is
 * already running (the port cannot bind) or Chrome cannot be found.
 */
export async function openUserBrowser(): Promise<UserBrowser> {
  // 1a. Explicit, user-managed debug Chrome.
  if (CONFIG.experts.chromeCdpUrl) {
    const browser = await chromium.connectOverCDP(CONFIG.experts.chromeCdpUrl, {
      timeout: 5000,
    });
    return { browser, release: async () => void (await browser.close().catch(() => {})) };
  }

  const port = CONFIG.experts.cdpPort;

  // 1b. A debug Chrome we launched earlier this session is still up.
  if (await debugPortAlive(port)) {
    const browser = await chromium.connectOverCDP(debugEndpoint(port), { timeout: 5000 });
    return { browser, release: async () => void (await browser.close().catch(() => {})) };
  }

  // 2. Launch the user's real Chrome profile with the port.
  const exe = findChromePath();
  if (!exe) {
    throw new Error(
      "could not find Chrome. Install Chrome, or set AQ_CHROME_PATH to chrome.exe.",
    );
  }
  const userDataDir = chromeUserDataDir();
  if (!userDataDir) throw new Error("could not locate your Chrome 'User Data' directory");
  const profile = pickProfile(userDataDir);
  if (!profile) throw new Error("no Chrome profiles found");

  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profile.dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  // Wait for the port. If Chrome for this profile was already running, our spawn
  // just forwarded to that instance and exited without binding the port.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await debugPortAlive(port)) {
      const browser = await chromium.connectOverCDP(debugEndpoint(port), { timeout: 5000 });
      return { browser, release: async () => void (await browser.close().catch(() => {})) };
    }
    await sleep(600);
  }

  throw new Error(
    `Chrome did not expose its debug port. This almost always means Chrome is ` +
      `already open on the "${profile.name}" profile — fully quit Chrome ` +
      `(close every window) and try again. The agent will reopen that profile ` +
      `for you with all your logins intact.`,
  );
}

/** Read the Firebase auth record from an Experts page in the given browser. */
export async function readSessionFromBrowser(browser: Browser): Promise<{
  email: string | null;
  displayName: string | null;
  token: string | null;
}> {
  const ctx = browser.contexts()[0];
  if (!ctx) return { email: null, displayName: null, token: null };

  let page = ctx.pages().find((p) => p.url().startsWith(CONFIG.experts.origin));
  const opened = !page;
  if (!page) {
    page = await ctx.newPage();
    await page.goto(`${CONFIG.experts.origin}/apply`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }

  try {
    // This runs in a browser we do NOT control (the user's own Chrome), so the
    // init-script shim was never installed here. esbuild rewrites named inner
    // consts into __name(...) calls, so define __name in-page first. A string
    // passed to evaluate is run verbatim - no esbuild transform - which is what
    // lets us bootstrap the shim safely.
    await page.evaluate(NAME_SHIM);
    return await page.evaluate(async () => {
      const rec = await new Promise<Record<string, unknown> | null>((resolve) => {
        let done = false;
        const finish = (v: Record<string, unknown> | null): void => {
          if (done) return;
          done = true;
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

      if (!rec) return { email: null, displayName: null, token: null };
      const sts = rec.stsTokenManager as
        | { accessToken?: string; expirationTime?: number }
        | undefined;
      return {
        email: (rec.email as string) ?? null,
        displayName: (rec.displayName as string) ?? null,
        token:
          sts?.accessToken && (sts.expirationTime ?? 0) > Date.now() ? sts.accessToken : null,
      };
    });
  } finally {
    // Leave a tab we found in place; only close one we opened.
    if (opened) await page.close().catch(() => {});
  }
}

/** Human-readable summary of what "Use my Chrome" would target, for the UI. */
export function describeUserChrome(): {
  available: boolean;
  chromePath: string | null;
  userDataDir: string | null;
  profiles: ChromeProfileInfo[];
  chosen: ChromeProfileInfo | null;
  reason?: string;
} {
  const chromePath = findChromePath();
  const userDataDir = chromeUserDataDir();
  if (!chromePath || !userDataDir) {
    return {
      available: false,
      chromePath,
      userDataDir,
      profiles: [],
      chosen: null,
      reason: !chromePath ? "Chrome not found" : "Chrome user-data directory not found",
    };
  }
  let profiles: ChromeProfileInfo[] = [];
  try {
    profiles = listChromeProfiles(userDataDir);
  } catch (err) {
    return {
      available: false,
      chromePath,
      userDataDir,
      profiles: [],
      chosen: null,
      reason: errMsg(err),
    };
  }
  return { available: true, chromePath, userDataDir, profiles, chosen: pickProfile(userDataDir) };
}
