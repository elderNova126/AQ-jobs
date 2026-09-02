import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { CONFIG, ensureDirs, ROOT } from "./config.js";
import { fetchBoard } from "./ashby/client.js";
import { fetchExpertsBoard } from "./experts/client.js";
import {
  authStatus,
  idToken,
  ingestPastedRefreshToken,
  signInInteractive,
  signOut,
} from "./experts/session.js";
import { describeUserChrome } from "./experts/chrome.js";
import { closeBrowser } from "./apply/browser.js";
import { applyToMany, isReadyToApply, missingIdentityFields } from "./apply/engine.js";
import { llmReady, llmStatus } from "./llm.js";
import { extractResumeText, guessIdentity } from "./resume/extract.js";
import { extractProfile } from "./resume/profile.js";
import { scoreResumeAgainstAllJobs } from "./scoring.js";
import { store } from "./store.js";
import type { ProgressEvent, Resume, ResumeIdentity } from "./types.js";
import { errMsg, newId, nowIso } from "./util.js";

ensureDirs();
store.load();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

/* ---------------------------------------------------------------- *
 * Server-sent events: one channel, every client sees all progress.
 * ---------------------------------------------------------------- */

const clients = new Set<Response>();

function emit(event: ProgressEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

app.get("/api/events", (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  clients.add(res);

  // Proxies drop idle event streams; a comment every 25s keeps it open.
  const beat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* cleaned up on close */
    }
  }, 25_000);

  req.on("close", () => {
    clearInterval(beat);
    clients.delete(res);
  });
});

/* ---------------------------------------------------------------- *
 * Job board
 * ---------------------------------------------------------------- */

/**
 * Pull both boards.
 *
 * Ashby is the 33 full-time roles and always loads. The Experts board adds
 * ~167 contract roles; it is public, but we pass a Firebase ID token when the
 * user has signed in because their listings endpoint is `optionalAuth` and may
 * personalise the result. A failure on either source must not lose the other.
 */
async function syncJobs(): Promise<{ total: number; ashby: number; experts: number }> {
  const results = await Promise.allSettled([
    fetchBoard(),
    CONFIG.experts.enabled
      ? idToken().then((t) => fetchExpertsBoard(t))
      : Promise.resolve([]),
  ]);

  const [ashbyRes, expertsRes] = results;
  const ashby = ashbyRes.status === "fulfilled" ? ashbyRes.value : [];
  const experts = expertsRes.status === "fulfilled" ? expertsRes.value : [];

  if (ashbyRes.status === "rejected") {
    console.warn(`[sync] Ashby board failed: ${errMsg(ashbyRes.reason)}`);
  }
  if (expertsRes.status === "rejected") {
    console.warn(`[sync] Experts board failed: ${errMsg(expertsRes.reason)}`);
  }
  if (ashby.length === 0 && experts.length === 0) {
    throw new Error("both job boards failed to load");
  }

  const jobs = [...ashby, ...experts];
  store.replaceJobs(jobs);
  await store.flush();
  emit({ kind: "job-sync", total: jobs.length });
  return { total: jobs.length, ashby: ashby.length, experts: experts.length };
}

app.post("/api/jobs/sync", async (_req, res) => {
  try {
    const counts = await syncJobs();
    res.json({ ok: true, ...counts, syncedAt: store.jobsSyncedAt() });
  } catch (err) {
    res.status(502).json({ ok: false, error: errMsg(err) });
  }
});

/* ---------------------------------------------------------------- *
 * AfterQuery Experts sign-in
 *
 * Google OAuth only, so the user signs in themselves in a real browser window
 * and Chrome's persistent profile keeps the session. No credential ever
 * reaches this process - see experts/session.ts.
 * ---------------------------------------------------------------- */

app.get("/api/auth/status", async (req, res) => {
  res.json(await authStatus(req.query.refresh === "1"));
});

/** What "Use my Chrome" would target: which profiles exist and which are logged in. */
app.get("/api/auth/chrome-info", (_req, res) => {
  res.json(describeUserChrome());
});

/**
 * Turn on "use my Chrome" for this session and read the login from it. This
 * launches the user's real Chrome profile with a debug port (see chrome.ts) and
 * reads the live session over CDP - no file copying, always a fresh token.
 */
app.post("/api/auth/use-my-chrome", async (req, res) => {
  const body = req.body as { profile?: string };
  if (typeof body.profile === "string" && body.profile) {
    CONFIG.experts.chromeProfile = body.profile;
  }
  CONFIG.experts.useMyChrome = true;
  emit({ kind: "auth-step", step: "opening your Chrome to read the AfterQuery login…" });
  const status = await authStatus(true);
  emit({ kind: "auth-done", status });
  if (status.signedIn) {
    try {
      await syncJobs();
    } catch (err) {
      console.warn(`[auth] post-attach sync failed: ${errMsg(err)}`);
    }
  }
  res.json(status);
});

/** Only one sign-in window at a time. */
let signingIn = false;

app.post("/api/auth/signin", async (_req, res) => {
  if (signingIn) {
    res.status(409).json({ error: "a sign-in window is already open" });
    return;
  }
  signingIn = true;
  try {
    const status = await signInInteractive((step) =>
      emit({ kind: "auth-step", step }),
    );
    emit({ kind: "auth-done", status });
    // A signed-in fetch may return a different set, so refresh the board.
    if (status.signedIn) {
      try {
        await syncJobs();
      } catch (err) {
        console.warn(`[auth] post-sign-in sync failed: ${errMsg(err)}`);
      }
    }
    res.json(status);
  } catch (err) {
    emit({ kind: "error", message: `sign-in failed: ${errMsg(err)}` });
    res.status(500).json({ error: errMsg(err) });
  } finally {
    signingIn = false;
  }
});

/**
 * Paste a Firebase refresh token (zero-browser route). With it the agent mints
 * fresh ID tokens forever via Google's secure-token endpoint. The API key
 * defaults to AfterQuery's public one; advanced users can override it.
 */
app.post("/api/auth/refresh-token", async (req, res) => {
  const body = req.body as { refreshToken?: string; apiKey?: string };
  if (!body.refreshToken?.trim()) {
    res.status(400).json({ error: "refreshToken is required" });
    return;
  }
  const status = await ingestPastedRefreshToken(body.refreshToken, body.apiKey);
  emit({ kind: "auth-done", status });
  if (status.signedIn) {
    try {
      await syncJobs();
    } catch (err) {
      console.warn(`[auth] post-paste sync failed: ${errMsg(err)}`);
    }
  }
  res.status(status.signedIn ? 200 : 502).json(status);
});

app.post("/api/auth/signout", async (_req, res) => {
  await signOut();
  const status = await authStatus(true);
  emit({ kind: "auth-done", status });
  res.json(status);
});

/* ---------------------------------------------------------------- *
 * State snapshot the UI renders from
 * ---------------------------------------------------------------- */

/** Resume without the full text blob, which is large and not needed client-side. */
function publicResume(r: Resume) {
  const { text: _text, ...rest } = r;
  return {
    ...rest,
    ready: isReadyToApply(r),
    missing: missingIdentityFields(r),
    hasProfile: r.profile !== null,
  };
}

app.get("/api/state", async (_req, res) => {
  const [llm, auth] = await Promise.all([llmStatus(), authStatus()]);
  const jobs = store.listJobs();
  res.json({
    llmReady: llm.ok,
    llmDetail: llm.detail,
    auth,
    /** What the "Use my Chrome" button can target. */
    chrome: describeUserChrome(),
    counts: {
      ashby: jobs.filter((j) => j.source === "ashby").length,
      experts: jobs.filter((j) => j.source === "experts").length,
    },
    provider: llm.provider,
    model: llm.model,
    dryRun: CONFIG.apply.dryRun,
    jobsSyncedAt: store.jobsSyncedAt(),
    jobs,
    resumes: store.listResumes().map(publicResume),
    applications: store.listApplications(),
  });
});

app.get("/api/scores/:resumeId", (req, res) => {
  const resumeId = req.params.resumeId!;
  if (!store.getResume(resumeId)) {
    res.status(404).json({ error: "no such resume" });
    return;
  }
  res.json({ scores: store.scoresForResume(resumeId) });
});

/* ---------------------------------------------------------------- *
 * Resumes
 * ---------------------------------------------------------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.ashby.maxResumeBytes },
});

const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md", ".rtf"]);

/**
 * Score a freshly uploaded resume against the whole board in the background.
 * The upload response returns immediately; the UI follows along over SSE.
 */
function kickOffScoring(resume: Resume): void {
  const jobs = store.listJobs();
  if (jobs.length === 0) return;
  void scoreResumeAgainstAllJobs(resume, jobs, emit).catch((err) => {
    emit({ kind: "error", message: `scoring failed: ${errMsg(err)}` });
  });
}

app.post("/api/resumes", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "no file uploaded (field name must be 'file')" });
      return;
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      res.status(400).json({
        error: `unsupported file type "${ext || "unknown"}". Use PDF, DOCX, TXT, MD or RTF.`,
      });
      return;
    }

    const { text, via, pages } = await extractResumeText(file.buffer, file.originalname);

    const id = newId("res");
    const storedPath = path.join(CONFIG.uploadsDir, `${id}${ext}`);
    await fs.promises.writeFile(storedPath, file.buffer);

    const guessed = guessIdentity(text);
    const identity: ResumeIdentity = {
      firstName: guessed.firstName,
      lastName: guessed.lastName,
      email: guessed.email,
      linkedinUrl: guessed.linkedinUrl,
      githubUrl: guessed.githubUrl,
      phone: guessed.phone,
      usAuthorized: null,
      needsSponsorship: null,
    };

    const resume: Resume = {
      id,
      label:
        typeof req.body?.label === "string" && req.body.label.trim()
          ? req.body.label.trim()
          : path.basename(file.originalname, ext),
      isPrimary: false,
      fileName: file.originalname,
      storedPath,
      mimeType: file.mimetype || "application/octet-stream",
      byteLength: file.size,
      text,
      textChars: text.length,
      identity,
      profile: null,
      createdAt: nowIso(),
    };

    store.putResume(resume);
    await store.flush();

    // Respond now so the UI is responsive; enrich and score in the background.
    res.json({
      ok: true,
      resume: publicResume(resume),
      extraction: { via, pages: pages ?? null, chars: text.length },
    });

    void (async () => {
      if (await llmReady()) {
        try {
          const profile = await extractProfile(text);
          const updated = store.updateResume(id, { profile });
          // Prefer resume-derived work-auth facts, but never overwrite a value
          // the user has already set by hand.
          if (updated) {
            const patch: Partial<ResumeIdentity> = {};
            if (updated.identity.usAuthorized == null) {
              patch.usAuthorized = profile.workAuthorization.usAuthorized;
            }
            if (updated.identity.needsSponsorship == null) {
              patch.needsSponsorship = profile.workAuthorization.needsSponsorship;
            }
            if (Object.keys(patch).length) {
              store.updateResume(id, { identity: { ...updated.identity, ...patch } });
            }
          }
          await store.flush();
        } catch (err) {
          console.warn(`[resume] profile extraction failed: ${errMsg(err)}`);
        }
      }
      const fresh = store.getResume(id);
      if (fresh) kickOffScoring(fresh);
    })();
  } catch (err) {
    res.status(400).json({ error: errMsg(err) });
  }
});

app.patch("/api/resumes/:id", async (req, res) => {
  const id = req.params.id!;
  const cur = store.getResume(id);
  if (!cur) {
    res.status(404).json({ error: "no such resume" });
    return;
  }

  const body = req.body as { label?: string; identity?: Partial<ResumeIdentity> };
  const patch: Partial<Resume> = {};

  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();

  if (body.identity && typeof body.identity === "object") {
    const inc = body.identity;
    const str = (v: unknown, fallback: string): string =>
      typeof v === "string" ? v.trim() : fallback;
    const tri = (v: unknown, fallback: boolean | null): boolean | null =>
      v === true || v === false ? v : v === null ? null : fallback;

    patch.identity = {
      firstName: str(inc.firstName, cur.identity.firstName),
      lastName: str(inc.lastName, cur.identity.lastName),
      email: str(inc.email, cur.identity.email),
      linkedinUrl: str(inc.linkedinUrl, cur.identity.linkedinUrl),
      githubUrl: str(inc.githubUrl, cur.identity.githubUrl),
      phone: str(inc.phone, cur.identity.phone ?? ""),
      location: str(inc.location, cur.identity.location ?? ""),
      websiteUrl: str(inc.websiteUrl, cur.identity.websiteUrl ?? ""),
      usAuthorized: tri(inc.usAuthorized, cur.identity.usAuthorized ?? null),
      needsSponsorship: tri(inc.needsSponsorship, cur.identity.needsSponsorship ?? null),
    };
  }

  const updated = store.updateResume(id, patch);
  await store.flush();
  res.json({ ok: true, resume: publicResume(updated!) });
});

app.post("/api/resumes/:id/primary", async (req, res) => {
  const id = req.params.id!;
  if (!store.getResume(id)) {
    res.status(404).json({ error: "no such resume" });
    return;
  }
  store.setPrimary(id);
  await store.flush();
  res.json({ ok: true, resumes: store.listResumes().map(publicResume) });
});

app.delete("/api/resumes/:id", async (req, res) => {
  const ok = store.deleteResume(req.params.id!);
  if (!ok) {
    res.status(404).json({ error: "no such resume" });
    return;
  }
  await store.flush();
  res.json({ ok: true });
});

app.post("/api/resumes/:id/rescore", (req, res) => {
  const resume = store.getResume(req.params.id!);
  if (!resume) {
    res.status(404).json({ error: "no such resume" });
    return;
  }
  const jobs = store.listJobs();
  if (jobs.length === 0) {
    res.status(409).json({ error: "no jobs synced yet" });
    return;
  }
  res.json({ ok: true, total: jobs.length });
  kickOffScoring(resume);
});

/* ---------------------------------------------------------------- *
 * Applying
 * ---------------------------------------------------------------- */

/** One apply run at a time: two runs would fight over browser contexts. */
let activeRun: string | null = null;

app.post("/api/apply", async (req, res) => {
  const body = req.body as {
    resumeId?: string;
    jobIds?: string[];
    minScore?: number;
    skipAlreadyApplied?: boolean;
  };

  const resume = body.resumeId ? store.getResume(body.resumeId) : undefined;
  if (!resume) {
    res.status(400).json({ error: "resumeId is required and must exist" });
    return;
  }

  const missing = missingIdentityFields(resume);
  if (missing.length) {
    res.status(422).json({
      error: `Fill in these applicant details first: ${missing.join(", ")}`,
      missing,
    });
    return;
  }

  if (activeRun) {
    res.status(409).json({ error: "an apply run is already in progress" });
    return;
  }

  // Selection: either explicit job ids, or every job at/above a score
  // threshold. Only Ashby roles can be submitted automatically.
  let jobs = store.listJobs().filter((j) => j.source === "ashby");
  if (Array.isArray(body.jobIds) && body.jobIds.length > 0) {
    const want = new Set(body.jobIds);
    jobs = jobs.filter((j) => want.has(j.id));
  } else if (typeof body.minScore === "number") {
    const threshold = body.minScore;
    jobs = jobs.filter((j) => {
      const s = store.getScore(resume.id, j.id);
      return s !== undefined && s.score >= threshold;
    });
  } else {
    res.status(400).json({ error: "provide jobIds or minScore" });
    return;
  }

  const skipAlreadyApplied = body.skipAlreadyApplied !== false;
  if (skipAlreadyApplied) {
    jobs = jobs.filter((j) => !store.hasSubmitted(resume.id, j.id));
  }

  if (jobs.length === 0) {
    res.status(409).json({ error: "no jobs matched that selection" });
    return;
  }

  const runId = newId("pending");
  activeRun = runId;
  res.json({ ok: true, accepted: jobs.length, jobs: jobs.map((j) => ({ id: j.id, title: j.title })) });

  void (async () => {
    try {
      await applyToMany(resume, jobs, emit, { skipAlreadyApplied });
    } catch (err) {
      emit({ kind: "error", message: `apply run failed: ${errMsg(err)}` });
    } finally {
      activeRun = null;
    }
  })();
});

app.get("/api/applications", (_req, res) => {
  res.json({ applications: store.listApplications() });
});

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

const server = app.listen(CONFIG.port, async () => {
  console.log(`\n  AfterQuery apply agent  ->  http://localhost:${CONFIG.port}\n`);

  const llm = await llmStatus();
  console.log(
    llm.ok
      ? `  LLM      : ${llm.provider}/${llm.model}`
      : `  LLM      : off - ${llm.detail}`,
  );
  if (CONFIG.apply.dryRun) {
    console.log("  DRY RUN  : on - applications are filled and validated but never submitted");
  }

  // Refresh the board on boot so the UI is never empty on first load.
  try {
    const n = store.listJobs().length;
    const c = await syncJobs();
    console.log(
      `  Jobs     : ${c.total} synced (${c.ashby} Ashby + ${c.experts} Experts)` +
        `${n ? "" : " (first sync)"}`,
    );
    const a = await authStatus();
    console.log(
      a.signedIn
        ? `  Experts  : signed in as ${a.email}
`
        : `  Experts  : not signed in - public listings only (sign in from the UI)
`,
    );
  } catch (err) {
    console.warn(`  Jobs     : sync failed (${errMsg(err)}); using cached board\n`);
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} - shutting down`);
  store.flushSync();
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
