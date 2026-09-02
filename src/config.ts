import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

/** Load .env by hand so we don't need a dependency for six keys. */
function loadDotenv(): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotenv();

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const CONFIG = {
  port: num(process.env.PORT, 5173),

  dataDir: path.join(ROOT, "data"),
  uploadsDir: path.join(ROOT, "data", "resumes"),
  storeFile: path.join(ROOT, "data", "store.json"),

  /** AfterQuery's Ashby board. `orgSlug` is the hosted-jobs-page name. */
  ashby: {
    orgSlug: "AfterQuery",
    boardApi:
      "https://api.ashbyhq.com/posting-api/job-board/AfterQuery?includeCompensation=true",
    jobsHost: "https://jobs.ashbyhq.com",
    /**
     * Public reCAPTCHA v3 site key, read from Ashby's own bootstrap payload
     * (window.__appData.recaptchaPublicSiteKey). AfterQuery does NOT have the
     * MigrateGoogleRecaptchaToEnterprise flag, so tokens are plain v3 with no
     * "ENT===" prefix. Verified against the live board.
     */
    recaptchaSiteKey: "6LeFb_YUAAAAALUD5h-BiQEp8JaFChe0e0A6r49Y",
    /** Ashby's own action name for a job application. */
    recaptchaAction: "job_apply",
    /** Ashby rejects uploads above this; mirrors their client-side limit. */
    maxResumeBytes: 50 * 1024 * 1024,
  },

  /** The AfterQuery Experts board - a second, larger source of roles. */
  experts: {
    origin: "https://experts.afterquery.com",
    /**
     * Persistent Chrome profile holding the Google/Firebase session. Must be a
     * real profile directory, not a storageState file: Firebase keeps its
     * refresh token in IndexedDB, which storageState does not capture.
     */
    profileDir: path.join(ROOT, "data", "experts-profile"),
    /**
     * Browser to drive for the Experts session. Blank auto-detects a real
     * installed Chrome, then Edge, then falls back to bundled Chromium.
     * Google often refuses OAuth from bundled Chromium, so a real browser
     * matters for the interactive sign-in.
     */
    browserChannel: process.env.AQ_BROWSER_CHANNEL ?? "",
    /**
     * Attach to a Chrome you already started with a debug port, e.g.
     *     chrome --remote-debugging-port=9222
     * then AQ_CHROME_CDP=http://localhost:9222. Advanced/manual route.
     */
    chromeCdpUrl: process.env.AQ_CHROME_CDP ?? "",
    /**
     * "Use my Chrome": read the login from your OWN Chrome profile.
     *
     * A page on localhost cannot read experts.afterquery.com's session (same
     * origin policy), and the on-disk session is snappy-compressed LevelDB that
     * only decodes through a browser engine. So the only clean way to reuse your
     * existing Google login is to let the agent LAUNCH your real Chrome profile
     * with a debug port and read the live session over CDP - no file copying,
     * always a fresh token. Requires that profile's Chrome to be closed first,
     * because Chrome only opens the debug port at startup.
     */
    useMyChrome: process.env.AQ_USE_MY_CHROME === "1",
    /** Which Chrome profile holds your AfterQuery login (e.g. "Default", "Profile 1"). */
    chromeProfile: process.env.AQ_CHROME_PROFILE ?? "",
    /** Path to chrome.exe / chrome; blank auto-detects. */
    chromePath: process.env.AQ_CHROME_PATH ?? "",
    /** Override the Chrome "User Data" root; blank auto-detects the OS default. */
    userDataDir: process.env.AQ_CHROME_USER_DATA_DIR ?? "",
    /** Debug port the agent opens on your Chrome. */
    cdpPort: num(process.env.AQ_CDP_PORT, 9222),
    /** How long the interactive sign-in window waits for the user. */
    signInTimeoutMs: num(process.env.AQ_SIGNIN_TIMEOUT_MS, 5 * 60 * 1000),
    /** 0 disables pulling the Experts board entirely. */
    enabled: process.env.AQ_EXPERTS !== "0",
  },

  llm: {
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    /** "auto" picks whichever key is present, preferring OpenAI. */
    provider: (process.env.AQ_LLM_PROVIDER ?? "auto") as "auto" | "openai" | "anthropic",
    /** Empty means "use the active provider's default". */
    model: process.env.AQ_MODEL ?? "",
    defaultOpenaiModel: "gpt-5",
    defaultAnthropicModel: "claude-opus-5",
    /** Parallel LLM calls when scoring a resume against the whole board. */
    scoreConcurrency: num(process.env.AQ_SCORE_CONCURRENCY, 6),
    /**
     * How many roles get a real LLM assessment per resume.
     *
     * Both boards together are ~206 roles, so scoring every one with the model
     * on every upload is a real cost. The free IDF heuristic ranks all of them
     * first and only the top N go to the model; the rest keep their heuristic
     * score and are labelled as such in the UI. 0 means "no limit".
     */
    scoreLimit: num(process.env.AQ_SCORE_LIMIT, 80),
    /**
     * Default reasoning effort for OpenAI models. Individual call sites
     * override it - scoring runs cheap, answering runs careful.
     */
    effort: (process.env.AQ_EFFORT ?? "low") as
      | "minimal"
      | "low"
      | "medium"
      | "high",
  },

  apply: {
    /** Parallel browser workers during a bulk apply. */
    concurrency: num(process.env.AQ_APPLY_CONCURRENCY, 2),
    /** Show the browser window (useful for debugging a failed apply). */
    headful: process.env.AQ_HEADFUL === "1",
    /**
     * Safety valve. When 1, everything runs for real EXCEPT the final submit
     * mutation, which is skipped and reported as "dry-run". Nothing reaches
     * AfterQuery's ATS.
     */
    dryRun: process.env.AQ_DRY_RUN === "1",
  },
};

export function ensureDirs(): void {
  fs.mkdirSync(CONFIG.uploadsDir, { recursive: true });
}

