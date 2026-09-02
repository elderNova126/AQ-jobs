import { CONFIG } from "../config.js";
import type { AshbyFormRender, AshbyJobPosting, Job } from "../types.js";
import { htmlToText, nowIso, retry } from "../util.js";
import { ASHBY_OPS, type AshbyOpName } from "./gql-ops.js";

/**
 * We present ourselves as the same Chrome build the real job board runs in.
 * Combined with the recovered GraphQL documents and Ashby's own custom header,
 * our requests are indistinguishable from the board's own traffic.
 */
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class AshbyError extends Error {
  constructor(
    message: string,
    readonly op: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AshbyError";
  }
}

/** Shape of the `?includeCompensation=true` posting-API payload we consume. */
interface BoardJob {
  id: string;
  title: string;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  location: string | null;
  isRemote: boolean;
  isListed: boolean;
  publishedAt: string | null;
  jobUrl: string;
  applyUrl: string;
  descriptionHtml: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string | null;
    scrapeableCompensationSalarySummary?: string | null;
  } | null;
}

/**
 * Fetch the public job board. This is Ashby's documented posting API and needs
 * no credentials; it is the same feed that powers afterquery.com/careers.
 */
export async function fetchBoard(): Promise<Job[]> {
  const res = await retry(
    async () => {
      const r = await fetch(CONFIG.ashby.boardApi, {
        headers: { Accept: "application/json", "User-Agent": CHROME_UA },
      });
      if (!r.ok) throw new Error(`board API HTTP ${r.status}`);
      return r;
    },
    { label: "fetchBoard" },
  );

  const body = (await res.json()) as { jobs?: BoardJob[] };
  const jobs = body.jobs ?? [];
  const syncedAt = nowIso();

  return jobs
    .filter((j) => j.isListed)
    .map<Job>((j) => ({
      id: j.id,
      source: "ashby",
      title: j.title.trim(),
      department: j.department ?? "Other",
      team: j.team ?? j.department ?? "Other",
      location: j.location ?? "Unspecified",
      isRemote: Boolean(j.isRemote),
      employmentType: j.employmentType ?? "Unspecified",
      compensation:
        j.compensation?.compensationTierSummary ??
        j.compensation?.scrapeableCompensationSalarySummary ??
        null,
      applyUrl: j.applyUrl,
      jobUrl: j.jobUrl,
      publishedAt: j.publishedAt,
      descriptionText: (j.descriptionPlain ?? htmlToText(j.descriptionHtml)).trim(),
      syncedAt,
    }));
}

/** POST one of the recovered operations to Ashby's job-board GraphQL endpoint. */
export async function ashbyGql<T>(
  op: AshbyOpName,
  variables: Record<string, unknown>,
  opts: { referer?: string } = {},
): Promise<T> {
  const query = ASHBY_OPS[op];
  const url = `${CONFIG.ashby.jobsHost}/api/non-user-graphql?op=${encodeURIComponent(op)}`;

  const res = await retry(
    async () => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          Origin: CONFIG.ashby.jobsHost,
          Referer: opts.referer ?? `${CONFIG.ashby.jobsHost}/${CONFIG.ashby.orgSlug}`,
          "User-Agent": CHROME_UA,
          // Ashby's client stamps every request with this; mirror it.
          "X-Ashby-Client-Request-Timestamp": new Date().toISOString(),
        },
        body: JSON.stringify({ operationName: op, variables, query }),
      });
      // 5xx and 429 are worth another go; 4xx is a real problem.
      if (r.status >= 500 || r.status === 429) {
        throw new Error(`${op} HTTP ${r.status}`);
      }
      return r;
    },
    { label: op },
  );

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new AshbyError(
      `${op}: ${body.errors.map((e) => e.message).join("; ")}`,
      op,
      body.errors,
    );
  }
  if (!body.data) throw new AshbyError(`${op}: empty response`, op);
  return body.data;
}

/**
 * Open a fresh application form.
 *
 * Every call mints a NEW `formRender.id` server-side (verified against the live
 * board). That identifier is the whole session: field values are written
 * against it and the submit references it, so no cookie or login is involved.
 * It also means a render must never be cached and reused across applications.
 */
export async function openApplicationForm(
  jobId: string,
): Promise<{ posting: AshbyJobPosting; form: AshbyFormRender }> {
  const data = await ashbyGql<{ jobPosting: AshbyJobPosting | null }>(
    "ApiJobPosting",
    {
      organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
      jobPostingId: jobId,
    },
    { referer: `${CONFIG.ashby.jobsHost}/${CONFIG.ashby.orgSlug}/${jobId}/application` },
  );
  const posting = data.jobPosting;
  if (!posting) throw new AshbyError(`job posting ${jobId} not found`, "ApiJobPosting");
  if (!posting.applicationForm) {
    throw new AshbyError(`job posting ${jobId} has no application form`, "ApiJobPosting");
  }
  return { posting, form: posting.applicationForm };
}

/** Flatten the section tree into the fields we actually have to fill. */
export function visibleFieldEntries(form: AshbyFormRender) {
  return form.sections
    .filter((s) => s.isHidden !== true)
    .flatMap((s) => s.fieldEntries)
    .filter((e) => e.isHidden !== true && !e.field.isDeactivated);
}

/** The control we submit with. Ashby names it "Submit" on every AfterQuery form. */
export function submitControl(form: AshbyFormRender): { identifier: string; title: string } {
  const explicit = form.formControls.find((c) => /submit/i.test(c.title));
  const control = explicit ?? form.formControls[0];
  if (!control) throw new AshbyError("form has no submit control", "submitControl");
  return control;
}

/* ------------------------- resume upload ------------------------- */

/** MIME types Ashby's own uploader accepts for a resume. */
export const RESUME_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

interface UploadHandle {
  handle: string;
  url: string;
  fields: Record<string, string> | string;
}

/**
 * Upload a resume and get back the opaque handle the form engine wants.
 *
 * Two details matter and both cost real debugging time to find:
 *  - the presigned POST policy pins `Content-Type`, but Ashby does NOT include
 *    that key in `fields`, so the client has to append it itself or S3 answers
 *    403 "Policy Condition failed";
 *  - `file` must be the LAST part in the multipart body, per S3 POST rules.
 */
export async function uploadResumeFile(args: {
  bytes: Buffer;
  filename: string;
  contentType: string;
}): Promise<string> {
  const data = await ashbyGql<{ fileUploadHandle: UploadHandle }>(
    "ApiCreateFileUploadHandle",
    {
      organizationHostedJobsPageName: CONFIG.ashby.orgSlug,
      fileUploadContext: "NonUserFormEngine",
      filename: args.filename,
      contentType: args.contentType,
      contentLength: args.bytes.length,
    },
  );

  const { handle, url, fields } = data.fileUploadHandle;
  const parsed: Record<string, string> =
    typeof fields === "string" ? JSON.parse(fields) : fields;

  const form = new FormData();
  if (parsed.key) form.append("key", parsed.key);
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== "key") form.append(k, v);
  }
  form.append("Content-Type", args.contentType);
  form.append(
    "file",
    new Blob([new Uint8Array(args.bytes)], { type: args.contentType }),
    args.filename,
  );

  const put = await retry(
    async () => {
      const r = await fetch(url, { method: "POST", body: form });
      if (!r.ok && (r.status >= 500 || r.status === 429)) {
        throw new Error(`S3 HTTP ${r.status}`);
      }
      return r;
    },
    { label: "resume upload" },
  );

  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    throw new AshbyError(
      `resume upload rejected (HTTP ${put.status}): ${detail.slice(0, 300)}`,
      "s3-upload",
    );
  }
  return handle;
}
