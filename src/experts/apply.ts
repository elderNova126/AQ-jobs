import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CONFIG } from "../config.js";
import { askStructured, llmReady } from "../llm.js";
import type { Application, Job, Resume } from "../types.js";
import { errMsg, newId, nowIso, truncate } from "../util.js";
import { store } from "../store.js";
import { CHROME_UA } from "../ashby/client.js";
import { RESUME_MIME } from "../ashby/client.js";
import { getExpertsRawJob } from "./client.js";
import { sessionInfo } from "./session.js";

/**
 * Automated submission to the AfterQuery Experts board.
 *
 * The flow mirrors what their own site does when you click "Apply Now" (captured
 * from a real submission):
 *   1. upload the resume        -> POST /api/resume/upload  (Bearer)  => { url }
 *   2. write a tailored pitch   -> one LLM call, job-matched, honest
 *   3. submit the application    -> POST /api/applications/submit-with-review (Bearer)
 *
 * Auth is the headless Firebase ID token (token-store); no browser is involved,
 * so unlike Ashby there is no reCAPTCHA to satisfy here.
 */

const SUBMIT_URL = `${CONFIG.experts.origin}/api/applications/submit-with-review`;
const UPLOAD_URL = `${CONFIG.experts.origin}/api/resume/upload`;

const PitchSchema = z.object({
  experience: z
    .string()
    .describe(
      "A first-person pitch (120-220 words) making the strongest HONEST case that " +
        "this candidate fits THIS role. Cite concrete companies, technologies, scale " +
        "and outcomes from the resume and connect them to the role's requirements. " +
        "Plain prose, no markdown, no greeting/sign-off, no invented facts.",
    ),
  school: z.string().describe("Most relevant/most recent institution, or '' if none in the resume"),
  major: z.string().describe("Field of study, or '' if not stated"),
  graduationYear: z.string().describe("Graduation year as a string, or '' if not stated"),
});

const PITCH_INSTRUCTIONS = `You are writing the free-text "experience" field of a job
application on behalf of a candidate, plus their education fields.

Rules:
- Strongest HONEST case only: use employers, technologies, scale and results the
  resume actually supports. Never invent or inflate.
- Make it specific to THIS role — name the requirements it targets and map the
  candidate's real work to them. No generic filler, no flattery.
- First person, plain prose, 120-220 words, no markdown, no salutation.
- For school/major/graduationYear, read them off the resume; use '' if absent.`;

async function writePitch(
  resume: Resume,
  job: Job,
): Promise<{ experience: string; school: string; major: string; graduationYear: string }> {
  const profileBlock = resume.profile
    ? `\n\nSTRUCTURED PROFILE\n${JSON.stringify(resume.profile, null, 1)}`
    : "";
  return askStructured({
    schema: PitchSchema,
    name: "experts_pitch",
    instructions: PITCH_INSTRUCTIONS,
    cachedSystem: `CANDIDATE RESUME\n================\n${truncate(resume.text, 60_000)}${profileBlock}`,
    user: [
      `ROLE: ${job.title}`,
      `TEAM: ${job.department}`,
      `PAY: ${job.compensation ?? "n/a"}`,
      "",
      truncate(job.descriptionText, 8000),
      "",
      "Write the experience pitch and education fields for this application.",
    ].join("\n"),
    // A tailored ~200-word pitch needs little reasoning; keep effort low so the
    // reasoning tokens don't blow the output budget (they count against it).
    maxTokens: 3000,
    effort: "low",
  });
}

/** Deterministic fallback pitch when no LLM is configured. */
function fallbackPitch(resume: Resume): {
  experience: string;
  school: string;
  major: string;
  graduationYear: string;
} {
  const p = resume.profile;
  const edu = p?.education?.[0] ?? "";
  const yearMatch = edu.match(/\b(19|20)\d{2}\b/);
  return {
    experience:
      p?.highlights?.length
        ? `${p.headline}. ${p.highlights.slice(0, 4).join(" ")}`.slice(0, 1200)
        : truncate(resume.text, 1000),
    school: edu.replace(/,.*$/, "").trim(),
    major: p?.domains?.[0] ?? "",
    graduationYear: yearMatch ? yearMatch[0] : "",
  };
}

/** Upload the resume to the user's Experts storage; returns the storage path. */
async function uploadResume(resume: Resume, token: string, uid: string): Promise<string> {
  const bytes = await fs.promises.readFile(resume.storedPath);
  const contentType =
    RESUME_MIME[path.extname(resume.fileName).toLowerCase()] ?? resume.mimeType;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), resume.fileName);
  form.append("userId", uid);
  form.append("fileName", resume.fileName);

  const r = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "User-Agent": CHROME_UA },
    body: form,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`resume upload failed (HTTP ${r.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await r.json()) as { url?: string };
  if (!data.url) throw new Error("resume upload returned no url");
  return data.url;
}

/**
 * Apply to one Experts role. Honours AQ_DRY_RUN: in dry-run it builds the exact
 * body (with the LLM pitch) and stops — it neither uploads nor submits, so there
 * is no side effect on your account.
 */
export async function applyToExpertsJob(resume: Resume, job: Job): Promise<Application> {
  const started = Date.now();
  const docId = job.id.replace(/^experts:/, "");

  const app: Application = {
    id: newId("app"),
    resumeId: resume.id,
    jobId: job.id,
    jobTitle: job.title,
    status: "running",
    score: null,
    fields: [],
    error: null,
    durationMs: null,
    createdAt: nowIso(),
    finishedAt: null,
  };
  const finish = (status: Application["status"], error: string | null): Application => {
    app.status = status;
    app.error = error;
    app.durationMs = Date.now() - started;
    app.finishedAt = nowIso();
    // Persist so "skip already applied" and the Status column know about it.
    // Not doing this is what let a bulk run re-submit roles filed minutes before.
    store.putApplication(app);
    return app;
  };

  const session = await sessionInfo();
  if (!session) {
    return finish("skipped", "Not signed in to AfterQuery Experts — sign in first (sidebar).");
  }

  // A required credential upload (licence, NPI, …) is a document we don't have
  // and shouldn't fabricate; refuse rather than submit an incomplete application.
  const requiredCred = (job.experts?.additionalFields ?? []).find(
    (f) => f.required && f.type === "credential",
  );
  if (requiredCred) {
    return finish(
      "failed",
      `This role requires a credential upload ("${requiredCred.label}") that the ` +
        `agent can't provide — apply manually via Open ↗.`,
    );
  }

  try {
    const rawJob = await getExpertsRawJob(docId, session.token);
    if (!rawJob) return finish("failed", "could not load the live job data for this role");

    const pitch = (await llmReady()) ? await writePitch(resume, job) : fallbackPitch(resume);
    const id = resume.identity;

    const formData = {
      firstName: id.firstName,
      lastName: id.lastName,
      linkedinUrl: id.linkedinUrl,
      school: pitch.school,
      major: pitch.major,
      graduationYear: pitch.graduationYear,
      experience: pitch.experience,
      jobSource: CONFIG.experts.jobSource,
      resumeUrl: "", // filled after upload
    };

    app.fields = [
      { title: "Name", path: "name", type: "String", value: `${id.firstName} ${id.lastName}`, source: "identity" },
      { title: "LinkedIn", path: "linkedinUrl", type: "Url", value: id.linkedinUrl, source: "identity" },
      { title: "Education", path: "education", type: "String", value: [pitch.school, pitch.major, pitch.graduationYear].filter(Boolean).join(", "), source: "llm" },
      { title: "Experience pitch", path: "experience", type: "LongText", value: truncate(pitch.experience, 280), source: "llm", rationale: "Tailored to this role from your resume" },
      { title: "Resume", path: "resumeUrl", type: "File", value: resume.fileName, source: "resume-file" },
    ];

    if (CONFIG.apply.dryRun) {
      return finish(
        "dry-run",
        "AQ_DRY_RUN=1: pitch written and body prepared; resume upload and submit skipped.",
      );
    }

    // Real submission: upload the resume, then POST the application.
    const resumeUrl = await uploadResume(resume, session.token, session.uid);
    formData.resumeUrl = resumeUrl;

    const body = {
      userId: session.uid,
      email: session.email ?? id.email,
      formData,
      jobData: rawJob,
      fileUrls: { resumeUrl },
      customData: { experience: pitch.experience },
      credentials: [] as unknown[],
      referrerId: null,
      sourceParam: null,
      clubId: null,
    };

    const res = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
        Origin: CONFIG.experts.origin,
        Referer: `${CONFIG.experts.origin}/apply/${(rawJob.link as string) ?? docId}`,
        "User-Agent": CHROME_UA,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(detail) as { error?: string; message?: string };
        msg = j.error ?? j.message ?? msg;
      } catch {
        if (detail) msg = detail.slice(0, 200);
      }
      // "Already applied" means an application for this role already exists on
      // your account - that is the goal state, not a failure. Record it as
      // submitted so it is skipped from now on instead of retried every run.
      if (/already applied/i.test(msg)) {
        return finish("submitted", "Already on file at AfterQuery Experts (applied earlier).");
      }
      return finish("failed", `Experts submit rejected: ${msg}`);
    }

    return finish("submitted", null);
  } catch (err) {
    return finish("failed", errMsg(err));
  }
}
