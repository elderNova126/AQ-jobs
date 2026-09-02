import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { CONFIG } from "../config.js";
import { ASHBY_OPS, type AshbyOpName } from "../ashby/gql-ops.js";
import { AshbyError, CHROME_UA } from "../ashby/client.js";
import { errMsg, humanPause, retry } from "../util.js";

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

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;
  launching = chromium
    .launch({
      headless: !CONFIG.apply.headful,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    })
    .then((b) => {
      browser = b;
      launching = null;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
      });
      return b;
    })
    .catch((err) => {
      launching = null;
      throw new Error(
        `could not start Chromium: ${errMsg(err)}. Run \`npx playwright install chromium\`.`,
      );
    });
  return launching;
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (b?.isConnected()) await b.close().catch(() => {});
}

/** Reported by the page so a submit failure can say what the browser saw. */
export interface PageGqlError {
  message: string;
}

export class ApplySession {
  private constructor(
    private readonly ctx: BrowserContext,
    readonly page: Page,
    readonly jobId: string,
  ) {}

  /**
   * Open the job's real application page. This is the same URL the "Apply now"
   * button on afterquery.com/careers points at.
   */
  static async open(jobId: string): Promise<ApplySession> {
    const b = await getBrowser();
    const ctx = await b.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: CHROME_UA,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      // Cut page weight without touching anything the form or captcha needs.
      serviceWorkers: "block",
    });

    // Images and fonts are irrelevant to us; blocking them halves load time.
    await ctx.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    const page = await ctx.newPage();
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
      await ctx.close().catch(() => {});
      throw new Error(`could not open application page for ${jobId}: ${errMsg(err)}`);
    }

    return new ApplySession(ctx, page, jobId);
  }

  /**
   * Mint a fresh reCAPTCHA v3 token.
   *
   * AfterQuery is not on Ashby's Enterprise reCAPTCHA flag, so the token is
   * passed through verbatim with no `ENT===` / `UNIVERSAL_ENT===` prefix. Tokens
   * are short-lived (~2 min), so we always mint immediately before submitting.
   */
  async recaptchaToken(action = CONFIG.ashby.recaptchaAction): Promise<string> {
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
    await this.ctx.close().catch(() => {});
  }
}
