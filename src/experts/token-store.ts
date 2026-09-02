import fs from "node:fs";
import { CONFIG } from "../config.js";
import { errMsg } from "../util.js";

/**
 * Headless AfterQuery Experts auth via a Firebase refresh token.
 *
 * This is the mechanism that makes "signed in" survive without a browser. A
 * Firebase session on disk carries a long-lived **refresh token** alongside the
 * ~1h ID token; exchanging it at Google's secure-token endpoint mints a fresh ID
 * token on demand. So we capture the refresh token once (from the user's Chrome,
 * the agent's own sign-in, or a manual paste), persist it, and from then on
 * every request gets a valid token with zero browser involvement — across
 * restarts, for as long as the refresh token stays valid (weeks).
 *
 * Only ID tokens (short-lived) ever leave this module. The refresh token is
 * persisted with 0600 perms and never returned to the UI.
 */

const SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
/** Re-mint this many ms before the ID token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface Persisted {
  refreshToken: string;
  apiKey: string;
}

interface State {
  refreshToken: string | null;
  apiKey: string | null;
  idToken: string | null;
  /** ID-token expiry, epoch seconds. */
  exp: number | null;
  email: string | null;
  lastError: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  loaded: boolean;
}

const state: State = {
  refreshToken: null,
  apiKey: null,
  idToken: null,
  exp: null,
  email: null,
  lastError: null,
  timer: null,
  loaded: false,
};

/** Decode a JWT payload (no verification) to read exp/email. */
export function decodeJwt(token: string): { exp?: number; email?: string } {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const o = JSON.parse(json) as { exp?: number; email?: string };
    return { exp: typeof o.exp === "number" ? o.exp : undefined, email: o.email };
  } catch {
    return {};
  }
}

/* ------------------------------- persistence ------------------------------- */

function load(): void {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const o = JSON.parse(fs.readFileSync(CONFIG.experts.authStoreFile, "utf8")) as Persisted;
    if (o.refreshToken && o.apiKey) {
      state.refreshToken = o.refreshToken;
      state.apiKey = o.apiKey;
      // Mint a token (and start the refresh loop) as soon as we boot.
      void exchange();
    }
  } catch {
    /* nothing persisted — expected until first capture */
  }
}

function persist(): void {
  try {
    if (state.refreshToken && state.apiKey) {
      fs.writeFileSync(
        CONFIG.experts.authStoreFile,
        JSON.stringify({ refreshToken: state.refreshToken, apiKey: state.apiKey }, null, 2),
        { mode: 0o600 },
      );
    } else {
      fs.rmSync(CONFIG.experts.authStoreFile, { force: true });
    }
  } catch (err) {
    console.warn(`[token-store] persist failed: ${errMsg(err)}`);
  }
}

/* -------------------------------- exchange -------------------------------- */

function scheduleRefresh(expSeconds: number | null): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!expSeconds) return;
  const fireIn = Math.max(30_000, expSeconds * 1000 - Date.now() - REFRESH_SKEW_MS);
  state.timer = setTimeout(() => void exchange(), fireIn);
  // A refresh timer should never keep the process alive on its own.
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

/** True for errors that will never fix themselves — stop retrying on these. */
const isFatalAuthError = (msg: string): boolean =>
  /TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|API key not valid|API_KEY/i.test(
    msg,
  );

/**
 * Exchange the stored refresh token for a fresh ID token, cache it, and
 * schedule the next refresh. Returns the new ID token, or null on failure.
 */
export async function exchange(): Promise<string | null> {
  if (!state.refreshToken || !state.apiKey) return null;
  try {
    const res = await fetch(`${SECURE_TOKEN_URL}?key=${encodeURIComponent(state.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(state.refreshToken)}`,
    });
    const data = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      refresh_token?: string;
      error?: { message?: string } | string;
      error_description?: string;
    };
    if (!res.ok || !data.id_token) {
      const msg =
        (typeof data.error === "object" ? data.error?.message : data.error) ??
        data.error_description ??
        `secure-token HTTP ${res.status}`;
      state.lastError = msg;
      if (isFatalAuthError(msg)) {
        // Revoked/expired refresh token: clear it so the UI prompts a re-capture.
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.refreshToken = null;
        state.apiKey = null;
        state.idToken = null;
        state.exp = null;
        persist();
      } else {
        scheduleRefresh(Math.floor(Date.now() / 1000) + 120); // transient — retry soon
      }
      return null;
    }

    const idToken = data.id_token;
    const { exp, email } = decodeJwt(idToken);
    state.idToken = idToken;
    state.exp = exp ?? null;
    state.email = email ?? state.email;
    state.lastError = null;
    // Firebase rotates refresh tokens periodically; keep the newest.
    if (data.refresh_token && data.refresh_token !== state.refreshToken) {
      state.refreshToken = data.refresh_token;
      persist();
    }
    scheduleRefresh(exp ?? null);
    return idToken;
  } catch (err) {
    state.lastError = errMsg(err);
    scheduleRefresh(Math.floor(Date.now() / 1000) + 120);
    return null;
  }
}

/* ---------------------------------- API ---------------------------------- */

/** Store a refresh token + API key, exchange immediately, and persist. */
export async function ingestRefreshToken(
  refreshToken: string,
  apiKey?: string,
): Promise<{ ok: boolean; error?: string; email?: string | null }> {
  const rt = refreshToken.trim();
  const key = (apiKey ?? CONFIG.experts.firebaseApiKey).trim();
  if (!rt) return { ok: false, error: "a refresh token is required" };
  if (!key) return { ok: false, error: "a Firebase Web API key is required" };
  load();
  state.refreshToken = rt;
  state.apiKey = key;
  persist();
  const token = await exchange();
  return token
    ? { ok: true, email: state.email }
    : { ok: false, error: state.lastError ?? "token exchange failed" };
}

/** A guaranteed-fresh ID token with no browser, or null if we have no creds. */
export async function freshToken(): Promise<string | null> {
  load();
  if (state.idToken && state.exp && state.exp * 1000 > Date.now() + 60_000) {
    return state.idToken;
  }
  if (state.refreshToken && state.apiKey) return exchange();
  return null;
}

export function hasRefreshCreds(): boolean {
  load();
  return Boolean(state.refreshToken && state.apiKey);
}

export function tokenStatus(): {
  hasRefreshToken: boolean;
  email: string | null;
  exp: number | null;
  lastError: string | null;
} {
  load();
  return {
    hasRefreshToken: Boolean(state.refreshToken && state.apiKey),
    email: state.email,
    exp: state.exp,
    lastError: state.lastError,
  };
}

export function clearTokenStore(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.refreshToken = null;
  state.apiKey = null;
  state.idToken = null;
  state.exp = null;
  state.email = null;
  state.lastError = null;
  persist();
}
