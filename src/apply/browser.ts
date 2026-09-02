import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../config.js";
import { ASHBY_OPS, type AshbyOpName } from "../ashby/gql-ops.js";
import { AshbyError, CHROME_UA } from "../ashby/client.js";
import { NAME_SHIM, errMsg, humanPause, retry, sleep } from "../util.js";

/**
 * A real Chrome, driven for two reasons.
 *
 * 1. reCAPTCHA. Ashby's submit mutation takes `recaptchaToken: String!` and the
 *    server enforces it. A valid v3 token can only be minted by Google's script
 *    running on the jobs.ashbyhq.com origin, so we load the actual application
 *    page and ask `grecaptcha.execute(siteKey, {action:'job_apply'})` for one -
 *    exactly what a human applicant's browser does. No bypass, no solver.
 * 2. Authenticity. Every GraphQL call is issued from inside that page via
 *    `fetch`, so origin, referer, cookies, UA and TLS fingerprint are the
 *    browser's own rather than a server-side imitation.
 */

let ctx: BrowserContext | null = null;
let launching: Promise<BrowserContext> | null = null;

/**
 * A shared, warm browser context for applying.
 *
 * Three things here exist specifically to keep reCAPTCHA v3 happy, because Ashby
 * uses the token's score for spam detection and a low score gets the application
 * flagged:
 *  - **Real Chrome** (channel chrome/msedge), not bundled Chromium — Google
 *    scores a genuine Chrome build far higher than headless test Chromium.
 *  - **A persistent profile** reused across runs — cookies and history make the
 *    browser look like a returning human rather than a fresh bot each time.
 *  - **Headful when you can** (`AQ_HEADFUL=1`) — a visible browser scores much
 *    better than any headless mode. On a desktop this is the single biggest win.
 */
async function launchCtx(): Promise<BrowserContext> {
  fs.mkdirSync(CONFIG.apply.profileDir, { recursive: true });
  const base = {
    headless: !CONFIG.apply.headful,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    serviceWorkers: "block" as const,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  };

  const setup = async (c: BrowserContext): Promise<BrowserContext> => {
    await c.addInitScript(NAME_SHIM);
    // Images/fonts/media are irrelevant to us; blocking them halves load time.
    await c.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });
    return c;
  };

  const channels = CONFIG.apply.browserChannel ? [CONFIG.apply.browserChannel] : ["chrome", "msedge"];
  let lastErr: unknown;
  for (const channel of channels) {
    try {
      return await setup(
        await chromium.launchPersistentContext(CONFIG.apply.profileDir, { ...base, channel }),
      );
    } catch (err) {
      lastErr = err;
    }
  }
  // Bundled Chromium as a last resort. It still works, but reCAPTCHA scores it
  // lower, so real Chrome is strongly preferred (see AQ_HEADFUL / channel).
  try {
    return await setup(
      await chromium.launchPersistentContext(CONFIG.apply.profileDir, {
        ...base,
        userAgent: CHROME_UA,
      }),
    );
  } catch {
    throw new Error(
      `could not start a browser for applying: ${errMsg(lastErr)}. ` +
        `Install Chrome, or run \`npx playwright install chromium\`.`,
    );
  }
}

async function getContext(): Promise<BrowserContext> {
  if (ctx) return ctx;
  if (launching) return launching;
  launching = launchCtx()
    .then((c) => {
      ctx = c;
      launching = null;
      c.on("close", () => {
        if (ctx === c) ctx = null;
      });
      return c;
    })
    .catch((err) => {
      launching = null;
      throw err;
    });
  return launching;
}

export async function closeBrowser(): Promise<void> {
  const c = ctx;
  ctx = null;
  await c?.close().catch(() => {});
}

/**
 * A little human-like activity so reCAPTCHA v3 sees "a person is here".
 *
 * v3 scores partly on interaction signals, so a few mouse moves, a small scroll
 * and a short dwell before we mint the token measurably lifts the score.
 */
async function humanize(page: Page): Promise<void> {
  try {
    const points: [number, number][] = [
      [200 + Math.random() * 300, 200 + Math.random() * 200],
      [500 + Math.random() * 400, 350 + Math.random() * 250],
      [300 + Math.random() * 500, 500 + Math.random() * 200],
    ];
    for (const [x, y] of points) {
      await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 10) });
      await sleep(120 + Math.random() * 220);
    }
    await page.mouse.wheel(0, 250 + Math.random() * 400);
    await sleep(400 + Math.random() * 600);
  } catch {
    /* warmup is best-effort */
  }
}

/** Reported by the page so a submit failure can say what the browser saw. */
export interface PageGqlError {
  message: string;
}

export class ApplySession {
  private constructor(
    readonly page: Page,
    readonly jobId: string,
  ) {}

  /**
   * Open the job's real application page. This is the same URL the "Apply now"
   * button on afterquery.com/careers points at.
   */
  static async open(jobId: string): Promise<ApplySession> {
    const context = await getContext();
    const page = await context.newPage();
    const url = `${CONFIG.ashby.jobsHost}/${CONFIG.ashby.orgSlug}/${jobId}/application`;

    try {
      await retry(
        async () => {
          const res = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          if (!res || res.status() >= 400) {
            throw new Error(`application page HTTP ${res?.status() ?? "no response"}`);
          }
        },
        { attempts: 3, baseMs: 800, label: "open application page" },
      );

      // The board injects grecaptcha after hydration; wait for it to be usable.
      await page.waitForFunction(
        () => {
          const g = (globalThis as { grecaptcha?: { execute?: unknown } }).grecaptcha;
          return typeof g?.execute === "function";
        },
        undefined,
        { timeout: 30_000 },
      );
    } catch (err) {
      await page.close().catch(() => {});
      throw new Error(`could not open application page for ${jobId}: ${errMsg(err)}`);
    }

    return new ApplySession(page, jobId);
  }

  /**
   * Mint a fresh reCAPTCHA v3 token.
   *
   * AfterQuery is not on Ashby's Enterprise reCAPTCHA flag, so the token is
   * passed through verbatim with no `ENT===` / `UNIVERSAL_ENT===` prefix. Tokens
   * are short-lived (~2 min), so we always mint immediately before submitting.
   */
  async recaptchaToken(action = CONFIG.ashby.recaptchaAction): Promise<string> {
    // Warm up interaction signals right before minting — lifts the v3 score.
    await humanize(this.page);
    const token = await this.page.evaluate(
      async ({ key, act }) => {
        const g = (globalThis as {
          grecaptcha?: {
            ready: (cb: () => void) => void;
            execute: (k: string, o: { action: string }) => Promise<string>;
          };
        }).grecaptcha;
        if (!g) throw new Error("grecaptcha not present");
        return await new Promise<string>((resolve, reject) => {
          g.ready(() => {
            g.execute(key, { action: act }).then(resolve, (e: unknown) =>
              reject(new Error(String(e))),
            );
          });
        });
      },
      { key: CONFIG.ashby.recaptchaSiteKey, act: action },
    );

    if (!token || token === "recaptcha_dummy_token") {
      throw new AshbyError(
        "reCAPTCHA returned no usable token; refusing to submit",
        "recaptcha",
      );
    }
    return token;
  }

  /**
   * Run an Ashby GraphQL operation from inside the page.
   *
   * Using the page's own `fetch` means the request carries the real origin and
   * referer for this job's application URL, which is what the board itself
   * sends.
   */
  async gql<T>(op: AshbyOpName, variables: Record<string, unknown>): Promise<T> {
    const query = ASHBY_OPS[op];
    const result = await this.page.evaluate(
      async ({ op: name, q, vars }) => {
        const r = await fetch(`/api/non-user-graphql?op=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Ashby-Client-Request-Timestamp": new Date().toISOString(),
          },
          body: JSON.stringify({ operationName: name, variables: vars, query: q }),
        });
        const text = await r.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* keep raw text for the error path */
        }
        return { status: r.status, json, text: text.slice(0, 600) };
      },
      { op, q: query, vars: variables },
    );

    if (result.status >= 400 && !result.json) {
      throw new AshbyError(`${op}: HTTP ${result.status} ${result.text}`, op);
    }
    const body = result.json as { data?: T; errors?: PageGqlError[] } | null;
    if (body?.errors?.length) {
      throw new AshbyError(
        `${op}: ${body.errors.map((e) => e.message).join("; ")}`,
        op,
        body.errors,
      );
    }
    if (!body?.data) throw new AshbyError(`${op}: empty response`, op);
    return body.data;
  }

  /** Small, jittered pause so our write cadence resembles a person typing. */
  async pause(min = 220, max = 620): Promise<void> {
    await humanPause(min, max);
  }

  async close(): Promise<void> {
    // Close only this page; the warm profile/context is shared and reused.
    await this.page.close().catch(() => {});
  }
}
