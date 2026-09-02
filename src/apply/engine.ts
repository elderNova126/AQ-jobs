import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import {
  RESUME_MIME,
  submitControl,
  uploadResumeFile,
  visibleFieldEntries,
} from "../ashby/client.js";
import { store } from "../store.js";
import type {
  Application,
  ApplicationFieldRecord,
  AshbyFormRender,
  Job,
  ProgressEvent,
  Resume,
} from "../types.js";
import { errMsg, humanPause, mapLimit, newId, nowIso } from "../util.js";
import { ApplySession } from "./browser.js";
import { resolveForm, type ResolvedField } from "./fill.js";
import { applyToExpertsJob } from "../experts/apply.js";

/** Fields the UI requires before an Apply button unlocks. */
export function missingIdentityFields(resume: Resume): string[] {
  const id = resume.identity;
  const missing: string[] = [];
  if (!id.firstName?.trim()) missing.push("First name");
  if (!id.lastName?.trim()) missing.push("Last name");
  if (!id.linkedinUrl?.trim()) missing.push("LinkedIn URL");
  if (!id.githubUrl?.trim()) missing.push("GitHub URL");
  // Every AfterQuery posting requires an email, so treat it as mandatory too.
  if (!id.email?.trim()) missing.push("Email");
  return missing;
}

export function isReadyToApply(resume: Resume): boolean {
  return missingIdentityFields(resume).length === 0;
}

function contentTypeFor(fileName: string, fallback: string): string {
  return RESUME_MIME[path.extname(fileName).toLowerCase()] ?? fallback;
}

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function recordOf(r: ResolvedField): ApplicationFieldRecord {
  return {
    title: r.entry.field.title || r.entry.field.path,
    path: r.entry.field.path,
    type: r.entry.field.type,
    value: r.wantsResumeFile ? "(resume file)" : displayValue(r.value),
    source: r.source,
    ...(r.rationale ? { rationale: r.rationale } : {}),
  };
}

export interface ApplyOptions {
  /** Skip jobs this resume has already been submitted to. Default true. */
  skipAlreadyApplied?: boolean;
  onStep?: (step: string) => void;
}

/**
 * Apply this resume to one job.
 *
 * Sequence, mirroring exactly what a person's browser does:
 *   1. open the real application page in Chrome (mints the form session)
 *   2. read the live form schema over GraphQL from inside that page
 *   3. decide a value for every field (saved data first, model for the rest)
 *   4. upload the resume to Ashby's presigned S3 target
 *   5. write each field to the server-side form render
 *   6. mint a fresh reCAPTCHA v3 token and submit
 *
 * The form render identifier from step 2 is the whole session, so steps 2-6
 * must use the same one.
 */
export async function applyToJob(
  resume: Resume,
  job: Job,
  opts: ApplyOptions = {},
): Promise<Application> {
  const started = Date.now();
  const step = (s: string): void => opts.onStep?.(s);

  const app: Application = {
    id: newId("app"),
    resumeId: resume.id,
    jobId: job.id,
    jobTitle: job.title,
    status: "running",
    score: store.getScore(resume.id, job.id)?.score ?? null,
    fields: [],
    error: null,
    durationMs: null,
    createdAt: nowIso(),
    finishedAt: null,
  };

  const finish = (
    status: Application["status"],
    error: string | null,
  ): Application => {
    app.status = status;
    app.error = error;
    app.durationMs = Date.now() - started;
    app.finishedAt = nowIso();
    store.putApplication(app);
    return app;
  };

  // The Experts board submits via a REST call as the signed-in user (its own
  // module handles resume upload + the tailored pitch + the POST). Hand off.
  if (job.source === "experts") {
    return applyToExpertsJob(resume, job);
  }

  const missing = missingIdentityFields(resume);
  if (missing.length) {
    return finish("skipped", `Missing applicant details: ${missing.join(", ")}`);
  }

  if (opts.skipAlreadyApplied !== false && store.hasSubmitted(resume.id, job.id)) {
    return finish("skipped", "Already submitted with this resume");
  }

  let session: ApplySession | null = null;
  try {
    step("opening application page");
    session = await ApplySession.open(job.id);

    step("reading form");
    // Read the form through the page so the render session belongs to this
    // browser context, same as a real applicant's.
    const data = await session.gql<{
      jobPosting: {
        applicationForm: AshbyFormRender;
        automatedProcessingLegalNotice?: {
          automatedProcessingLegalNoticeRuleId: string;
        } | null;
      } | null;
    }>("ApiJobPosting", {
      organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
      jobPostingId: job.id,
    });

    const posting = data.jobPosting;
    if (!posting?.applicationForm) throw new Error("job posting has no application form");
    const form = posting.applicationForm;
    const renderId = form.id;
    const formDefinitionId = form.sourceFormDefinitionId;
    const control = submitControl(form);

    step("deciding answers");
    const { resolved, unanswered } = await resolveForm(form, resume, job);
    app.fields = resolved.map(recordOf);

    if (unanswered.length) {
      return finish(
        "failed",
        `Could not answer required field(s): ${unanswered
          .map((u) => `${u.title} (${u.reason})`)
          .join("; ")}`,
      );
    }

    // --- resume upload -------------------------------------------------
    const fileFields = resolved.filter((r) => r.wantsResumeFile);
    if (fileFields.length) {
      step("uploading resume");
      const bytes = await fs.promises.readFile(resume.storedPath);
      if (bytes.length > CONFIG.ashby.maxResumeBytes) {
        throw new Error(`resume is ${bytes.length} bytes; Ashby's limit is 50 MB`);
      }
      const handle = await uploadResumeFile({
        bytes,
        filename: resume.fileName,
        contentType: contentTypeFor(resume.fileName, resume.mimeType),
      });
      for (const f of fileFields) {
        await session.gql("ApiSetFormValueToFile", {
          organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
          formRenderIdentifier: renderId,
          path: f.entry.field.path,
          fileHandle: handle,
          formDefinitionIdentifier: formDefinitionId,
        });
        await session.pause(120, 300);
      }
    }

    // --- text / choice fields ------------------------------------------
    step("filling fields");
    let latest: AshbyFormRender | null = null;
    for (const f of resolved) {
      if (f.wantsResumeFile) continue;
      const res = await session.gql<{ setFormValue: AshbyFormRender }>("ApiSetFormValue", {
        organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
        formRenderIdentifier: renderId,
        path: f.entry.field.path,
        value: f.value,
        formDefinitionIdentifier: formDefinitionId,
      });
      latest = res.setFormValue;
      // Human cadence between fields; short enough to stay quick overall.
      await session.pause(160, 420);
    }

    // Cheap pre-submit check against the server's own view of the form.
    if (latest) {
      const stillEmpty = visibleFieldEntries(latest)
        .filter((e) => e.isRequired && e.fieldValue == null)
        .map((e) => e.field.title || e.field.path);
      if (stillEmpty.length) {
        throw new Error(
          `server still reports these required fields as empty: ${stillEmpty.join(", ")}`,
        );
      }
    }

    if (CONFIG.apply.dryRun) {
      return finish(
        "dry-run",
        "AQ_DRY_RUN=1: form was filled and validated, submit deliberately skipped",
      );
    }

    // --- submit ---------------------------------------------------------
    type SubmitResult = {
      submitApplicationFormAction: {
        applicationFormResult: (Partial<AshbyFormRender> & { _?: unknown }) | null;
        messages: { blockMessageForCandidateHtml: string | null } | null;
      };
    };
    const submitOnce = async (): Promise<SubmitResult> => {
      // A fresh reCAPTCHA token (minted after a warmup) for each attempt.
      const token = await session!.recaptchaToken();
      return session!.gql<SubmitResult>("ApiSubmitSingleApplicationFormAction", {
        organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
        jobPostingId: job.id,
        formRenderIdentifier: renderId,
        formDefinitionIdentifier: formDefinitionId,
        actionIdentifier: control.identifier,
        recaptchaToken: token,
        sourceAttributionCode: null,
        viewedAutomatedProcessingLegalNoticeRuleId:
          posting.automatedProcessingLegalNotice?.automatedProcessingLegalNoticeRuleId ?? null,
        deviceFingerprint: null,
        applicationRequestId: null,
      });
    };

    const spamFlagged = (r: SubmitResult): boolean =>
      /flagged as possible spam|possible spam/i.test(
        JSON.stringify(r.submitApplicationFormAction ?? {}),
      );

    step("verifying (reCAPTCHA)");
    step("submitting");
    let result = await submitOnce();

    // Ashby scores the reCAPTCHA token for spam; a low score gets flagged with a
    // "submit again" hint. A second attempt with a fresh token, after more
    // warmup and a short human-paced pause, usually clears a borderline score.
    if (spamFlagged(result)) {
      step("flagged as spam — retrying with a fresh token");
      await session.pause(2500, 4500);
      result = await submitOnce();
    }

    const payload = result.submitApplicationFormAction;
    const formBack = payload.applicationFormResult;
    const rejected =
      formBack != null && ("formErrors" in formBack || "sections" in formBack);

    if (rejected) {
      const msgs: string[] = [];
      for (const e of formBack.formErrors ?? []) if (e?.message) msgs.push(e.message);
      for (const m of formBack.errorMessages ?? []) if (m) msgs.push(m);
      const block = payload.messages?.blockMessageForCandidateHtml;
      if (block) msgs.push(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      let detail = msgs.length ? msgs.join("; ") : "Ashby rejected the submission without a reason";
      // A spam flag is a low reCAPTCHA score. Point at the fix that actually
      // moves the score, rather than leaving the user to guess.
      if (/spam/i.test(detail) && !CONFIG.apply.headful) {
        detail +=
          " — this is a low reCAPTCHA score from headless mode. Set AQ_HEADFUL=1 " +
          "(and use real Chrome) and re-apply; a visible browser scores far higher.";
      }
      return finish("failed", detail);
    }

    return finish("submitted", null);
  } catch (err) {
    return finish("failed", errMsg(err));
  } finally {
    await session?.close();
  }
}

/**
 * Apply to many jobs for one resume.
 *
 * Runs a small number of browser contexts in parallel (default 2). Each context
 * is fully independent — its own form render, its own captcha token — so a
 * failure on one job cannot corrupt another.
 */
export async function applyToMany(
  resume: Resume,
  jobs: Job[],
  emit: (e: ProgressEvent) => void,
  opts: ApplyOptions = {},
): Promise<{ runId: string; applications: Application[] }> {
  const runId = newId("run");
  emit({ kind: "apply-start", runId, resumeId: resume.id, jobIds: jobs.map((j) => j.id) });

  let done = 0;
  const runOne = async (job: Job): Promise<Application> => {
    const app = await applyToJob(resume, job, {
      ...opts,
      onStep: (s) =>
        emit({ kind: "apply-step", runId, jobId: job.id, jobTitle: job.title, step: s }),
    });
    done++;
    emit({ kind: "apply-one", runId, application: app, done, total: jobs.length });
    return app;
  };

  // Experts submits are plain REST calls with no captcha - run them in parallel.
  // Ashby submits go through reCAPTCHA v3 and Ashby's own spam scoring, and six
  // applications to one company inside two minutes reads as a bot no matter how
  // good each token is. So Ashby runs strictly one at a time with a human-paced,
  // randomised gap between submissions.
  const expertsJobs = jobs.filter((j) => j.source === "experts");
  const ashbyJobs = jobs.filter((j) => j.source !== "experts");

  const expertsDone = mapLimit(expertsJobs, CONFIG.apply.concurrency, runOne);
  const ashbyDone: Application[] = [];
  for (let i = 0; i < ashbyJobs.length; i++) {
    if (i > 0) {
      const gap = CONFIG.apply.ashbyGapMs;
      emit({ kind: "apply-step", runId, jobId: ashbyJobs[i]!.id, jobTitle: ashbyJobs[i]!.title, step: "pacing before next Ashby submit" });
      await humanPause(gap * 0.7, gap * 1.3);
    }
    ashbyDone.push(await runOne(ashbyJobs[i]!));
  }
  const applications = [...(await expertsDone), ...ashbyDone];

  await store.flush();
  const submitted = applications.filter(
    (a) => a.status === "submitted" || a.status === "dry-run",
  ).length;
  const failed = applications.filter((a) => a.status === "failed").length;
  emit({ kind: "apply-done", runId, submitted, failed });

  return { runId, applications };
}
