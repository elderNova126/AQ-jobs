import { CONFIG } from "../config.js";
import type { Job } from "../types.js";
import { CHROME_UA } from "../ashby/client.js";
import { htmlToText, nowIso, retry } from "../util.js";

/**
 * The AfterQuery Experts board (experts.afterquery.com).
 *
 * A second, much larger board than the Ashby one: ~167 contract/hourly roles
 * plus a handful of talent pools, against 33 full-time roles on Ashby.
 *
 * Their own client fetches it as:
 *     authFetch("/api/jobs/listings", { optionalAuth: true })
 *
 * `optionalAuth` is the important word. The endpoint answers fine with no
 * credentials - which is how we get all 167 unauthenticated - but the server
 * *does* read a bearer token when one is present, so a signed-in fetch can
 * return a personalised set. We therefore pass an ID token whenever the user
 * has signed in (see session.ts) and fall back to anonymous otherwise.
 */

/** Shape of one entry in the listings payload. */
interface ExpertsJob {
  id: number;
  docId: string;
  title: string;
  salary: string | null;
  description: string | null;
  department: string | null;
  link: string | null;
  postedDate: string | null;
  featured?: boolean;
  archived?: boolean;
  isPool?: boolean;
  requireAssessment?: boolean;
  requireInterview?: boolean;
  required_qualifications?: string[];
  detailPage?: {
    fullDescription?: string;
    why_apply?: string[];
  } | null;
  applicationFields?: {
    showGithub?: boolean;
    showPortfolio?: boolean;
    showCoverLetter?: boolean;
    showProgrammingLanguages?: boolean;
    customMessage?: string;
    additionalFields?: {
      name: string;
      type: string;
      label: string;
      description?: string;
      required?: boolean;
      options?: string[];
    }[];
  } | null;
}

interface ListingsPayload {
  jobs?: ExpertsJob[];
  pools?: ExpertsJob[];
}

/**
 * Flatten a listing into the text we score against.
 *
 * Their descriptions are short, so the qualifications and "why apply" bullets
 * carry most of the matchable signal - without them the scorer has very little
 * to work with and every role looks alike.
 */
function descriptionOf(j: ExpertsJob): string {
  const parts: string[] = [];
  if (j.description) parts.push(j.description.trim());
  const full = j.detailPage?.fullDescription?.trim();
  if (full && full !== j.description?.trim()) parts.push(htmlToText(full));
  if (j.required_qualifications?.length) {
    parts.push("REQUIRED QUALIFICATIONS", ...j.required_qualifications.map((q) => `- ${q}`));
  }
  if (j.detailPage?.why_apply?.length) {
    parts.push("WHY APPLY", ...j.detailPage.why_apply.map((w) => `- ${w}`));
  }
  const extra = j.applicationFields?.additionalFields ?? [];
  if (extra.length) {
    parts.push(
      "APPLICATION ALSO ASKS FOR",
      ...extra.map((f) => `- ${f.label}${f.required ? " (required)" : ""}`),
    );
  }
  return parts.join("\n").trim();
}

function toJob(j: ExpertsJob, isPool: boolean, syncedAt: string): Job {
  const af = j.applicationFields ?? {};
  const slug = j.link ?? j.docId;
  return {
    id: `experts:${j.docId}`,
    source: "experts",
    title: j.title.trim() + (isPool ? " (pool)" : ""),
    department: j.department ?? "Miscellaneous",
    team: j.department ?? "Miscellaneous",
    // Every Experts role is remote/project-based.
    location: "Remote",
    isRemote: true,
    employmentType: isPool ? "Talent pool" : "Contract",
    compensation: j.salary ?? null,
    applyUrl: `${CONFIG.experts.origin}/apply?job=${j.docId}`,
    jobUrl: `${CONFIG.experts.origin}/apply/${slug}`,
    publishedAt: j.postedDate ?? null,
    descriptionText: descriptionOf(j),
    syncedAt,
    experts: {
      isPool,
      requireAssessment: Boolean(j.requireAssessment),
      requireInterview: Boolean(j.requireInterview),
      additionalFields: (af.additionalFields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        label: f.label,
        required: Boolean(f.required),
        ...(f.description ? { description: f.description } : {}),
        ...(f.options?.length ? { options: f.options } : {}),
      })),
      showGithub: Boolean(af.showGithub),
      showPortfolio: Boolean(af.showPortfolio),
      showCoverLetter: Boolean(af.showCoverLetter),
      showProgrammingLanguages: Boolean(af.showProgrammingLanguages),
    },
  };
}

/**
 * Fetch the Experts board. Pass a Firebase ID token to fetch as the signed-in
 * user; omit it for the anonymous listing.
 */
/** The raw listings objects, kept so we can send Ashby-style `jobData` on apply. */
const rawByDocId = new Map<string, ExpertsJob>();

/** The exact raw listings object for a docId (for the submit body's `jobData`). */
export async function getExpertsRawJob(
  docId: string,
  idToken?: string | null,
): Promise<Record<string, unknown> | null> {
  if (rawByDocId.has(docId)) return rawByDocId.get(docId) as unknown as Record<string, unknown>;
  await fetchExpertsBoard(idToken); // refills the cache
  return (rawByDocId.get(docId) as unknown as Record<string, unknown>) ?? null;
}

export async function fetchExpertsBoard(idToken?: string | null): Promise<Job[]> {
  const res = await retry(
    async () => {
      const r = await fetch(`${CONFIG.experts.origin}/api/jobs/listings`, {
        headers: {
          Accept: "application/json",
          "User-Agent": CHROME_UA,
          Referer: `${CONFIG.experts.origin}/apply`,
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
      });
      if (!r.ok) throw new Error(`experts listings HTTP ${r.status}`);
      return r;
    },
    { label: "fetchExpertsBoard" },
  );

  const body = (await res.json()) as ListingsPayload;
  const syncedAt = nowIso();

  rawByDocId.clear();
  for (const j of [...(body.jobs ?? []), ...(body.pools ?? [])]) {
    if (j?.docId) rawByDocId.set(j.docId, j);
  }
  const jobs = (body.jobs ?? []).filter((j) => !j.archived).map((j) => toJob(j, false, syncedAt));
  const pools = (body.pools ?? []).filter((j) => !j.archived).map((j) => toJob(j, true, syncedAt));

  // A pool and a job can share a docId; the job listing is the more specific.
  const seen = new Set(jobs.map((j) => j.id));
  return [...jobs, ...pools.filter((p) => !seen.has(p.id))];
}
