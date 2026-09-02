import { z } from "zod";
import { askStructured, llmReady } from "../llm.js";
import type {
  AshbyFieldDef,
  AshbyFieldEntry,
  AshbyFormRender,
  Job,
  Resume,
} from "../types.js";
import { truncate } from "../util.js";
import { visibleFieldEntries } from "../ashby/client.js";

/** One resolved answer, ready to write to the form. */
export interface ResolvedField {
  entry: AshbyFieldEntry;
  /** `null` means "leave blank" (only ever chosen for optional fields). */
  value: unknown;
  /** Set instead of `value` when the field takes an uploaded file. */
  wantsResumeFile?: boolean;
  source: "identity" | "resume-file" | "profile" | "llm" | "default";
  rationale?: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Everything we can match a field on: path, title, and human-readable path. */
function haystack(f: AshbyFieldDef): string {
  return norm(`${f.path} ${f.title} ${f.humanReadablePath}`);
}

const has = (f: AshbyFieldDef, ...needles: string[]): boolean => {
  const h = haystack(f);
  return needles.some((n) => h.includes(n));
};

/**
 * Questions that are verifiable claims about the applicant's legal status.
 *
 * These must never be defaulted or guessed at: answering "yes, I need visa
 * sponsorship" on someone's behalf when it is not true is a misrepresentation
 * on a real job application. If we cannot establish the answer from the user's
 * saved settings, the resume, or the model, we fail the application and tell
 * the user exactly which control to set.
 */
function isLegalStatusQuestion(f: AshbyFieldDef): boolean {
  return has(
    f,
    "legally authorized",
    "authorized to work",
    "work authorization",
    "sponsorship",
    "require a visa",
    "visa status",
    "right to work",
    "security clearance",
    "clearance",
  );
}

/* ------------------------------------------------------------------ *
 * Type-aware serialisation
 * ------------------------------------------------------------------ */

/**
 * Coerce a value into the JSON shape Ashby's form engine expects for a field
 * type. `setFormValue` takes a `JSON` scalar, so the wire accepts anything —
 * which means a wrong shape fails at submit time with a vague message. Getting
 * this right per type is what makes an application actually go through.
 */
export function coerceForField(def: AshbyFieldDef, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;

  const asString = (): string =>
    typeof raw === "string" ? raw.trim() : String(raw).trim();

  switch (def.type) {
    case "Boolean":
      if (typeof raw === "boolean") return raw;
      return /^(yes|true|1|y)$/i.test(asString());

    case "Number":
    case "Currency":
    case "Score":
    case "LinearRating":
    case "NPSRating": {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      // Strip currency symbols and separators, but require an actual digit:
      // Number("") is 0, so a non-numeric answer would otherwise become zero.
      const cleaned = asString().replace(/[^0-9.-]/g, "");
      if (!/\d/.test(cleaned)) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }

    case "Date": {
      const s = asString();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      // Format from local components. toISOString() would convert to UTC and
      // shift the date back a day for anyone west of Greenwich.
      const pad = (x: number): string => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    case "ValueSelect": {
      const chosen = matchSelectable(def, asString());
      return chosen ?? null;
    }

    case "MultiValueSelect": {
      const items = Array.isArray(raw) ? raw.map(String) : asString().split(/\s*[,;|]\s*/);
      const mapped = items
        .map((i) => matchSelectable(def, i))
        .filter((v): v is string => Boolean(v));
      return mapped.length ? [...new Set(mapped)] : null;
    }

    default:
      // String, Email, Phone, Url, SocialLink, LongText, RichText, Location,
      // and anything Ashby adds later: a trimmed string is the right default.
      return asString() || null;
  }
}

/**
 * Map a free-text answer onto one of the option values Ashby will accept.
 * A ValueSelect only takes an exact `value` from `selectableValues`, so an
 * almost-right string ("yes, I am") would be silently dropped.
 */
function matchSelectable(def: AshbyFieldDef, answer: string): string | null {
  const options = (def.selectableValues ?? []).filter((o) => !o.isArchived);
  if (options.length === 0) return answer || null;
  const a = norm(answer);
  if (!a) return null;

  const exact =
    options.find((o) => norm(o.value) === a) ?? options.find((o) => norm(o.label) === a);
  if (exact) return exact.value;

  // Yes/No questions dominate these forms; resolve them decisively.
  const yes = /^(yes|y|true|1|authorized|i am|i do)\b/.test(a);
  const no = /^(no|n|false|0|not|i am not|i do not|none)\b/.test(a);
  if (yes || no) {
    const want = yes ? /^(yes|y|true)$/ : /^(no|n|false)$/;
    const hit = options.find((o) => want.test(norm(o.value)) || want.test(norm(o.label)));
    if (hit) return hit.value;
  }

  const partial = options.find(
    (o) => a.includes(norm(o.value)) || norm(o.value).includes(a) || a.includes(norm(o.label)),
  );
  return partial ? partial.value : null;
}

/* ------------------------------------------------------------------ *
 * Deterministic resolution
 * ------------------------------------------------------------------ */

/**
 * Answer the fields we can answer from the applicant's own data, with no model
 * involved. Returns `undefined` when this field is not one we recognise, which
 * hands it to the LLM step.
 */
function resolveKnown(
  entry: AshbyFieldEntry,
  resume: Resume,
): ResolvedField | undefined {
  const f = entry.field;
  const id = resume.identity;
  const full = `${id.firstName} ${id.lastName}`.trim();

  const out = (value: unknown, source: ResolvedField["source"]): ResolvedField => ({
    entry,
    value: coerceForField(f, value),
    source,
  });

  if (f.type === "File") {
    // Ashby's only file field on these postings is the resume itself. If a
    // posting ever adds a second (cover letter, transcript), we still attach
    // the resume to the resume-ish one and leave the other to the LLM/blank.
    if (f.path === "_systemfield_resume" || has(f, "resume", "cv", "curriculum")) {
      return { entry, value: null, wantsResumeFile: true, source: "resume-file" };
    }
    return undefined;
  }

  if (f.path === "_systemfield_name" || (f.type === "String" && has(f, "full name"))) {
    return out(full, "identity");
  }
  if (has(f, "first name", "given name", "forename")) return out(id.firstName, "identity");
  if (has(f, "last name", "surname", "family name")) return out(id.lastName, "identity");

  if (f.path === "_systemfield_email" || f.type === "Email" || has(f, "email")) {
    return out(id.email, "identity");
  }
  if (f.type === "Phone" || has(f, "phone", "mobile", "telephone")) {
    return id.phone ? out(id.phone, "identity") : undefined;
  }

  if (has(f, "linkedin")) return out(id.linkedinUrl, "identity");
  if (has(f, "github")) return out(id.githubUrl, "identity");
  if (has(f, "portfolio", "personal website", "personal site", "website", "homepage")) {
    return id.websiteUrl ? out(id.websiteUrl, "identity") : undefined;
  }

  if (f.type === "Location" || has(f, "location", "city", "where are you based")) {
    return id.location ? out(id.location, "identity") : undefined;
  }

  // Work authorization: user's explicit setting wins, then resume evidence.
  const auth = resume.profile?.workAuthorization;
  if (has(f, "legally authorized", "authorized to work", "work authorization")) {
    const explicit = id.usAuthorized;
    if (explicit === true || explicit === false) {
      return out(explicit ? "Yes" : "No", "identity");
    }
    if (auth?.usAuthorized === true || auth?.usAuthorized === false) {
      return {
        ...out(auth.usAuthorized ? "Yes" : "No", "profile"),
        rationale: `From resume: ${auth.evidence}`,
      };
    }
    return undefined; // fall through to the LLM
  }
  if (has(f, "sponsorship", "require a visa", "visa sponsorship")) {
    const explicit = id.needsSponsorship;
    if (explicit === true || explicit === false) {
      return out(explicit ? "Yes" : "No", "identity");
    }
    if (auth?.needsSponsorship === true || auth?.needsSponsorship === false) {
      return {
        ...out(auth.needsSponsorship ? "Yes" : "No", "profile"),
        rationale: `From resume: ${auth.evidence}`,
      };
    }
    return undefined;
  }

  return undefined;
}

/* ------------------------------------------------------------------ *
 * LLM resolution for unexpected questions
 * ------------------------------------------------------------------ */

const AnswerSchema = z.object({
  answers: z.array(
    z.object({
      fieldId: z.string().describe("Echo the exact fieldId given in the question list"),
      answer: z
        .string()
        .describe(
          "The answer as plain text. For a choice field this MUST be exactly one of the allowed option values. For a yes/no field use 'Yes' or 'No'. Use an empty string only for an optional field you are choosing to leave blank.",
        ),
      rationale: z.string().describe("One short sentence on why this answer"),
    }),
  ),
});

const ANSWER_INSTRUCTIONS = `You are completing a job application form on behalf of a candidate.

Your first priority is presenting the strongest honest case that this candidate
fits THIS specific job. Read the job posting and answer every question the way a
well-prepared applicant for that exact role would.

Hard rules, in order:
1. Never state a falsehood. Do not invent employers, degrees, credentials,
   clearances, years of experience, or authorizations that the resume does not
   support.
2. For questions of verifiable fact (work authorization, visa sponsorship,
   degrees, current employer, notice period), answer only from resume evidence.
   If the resume is silent and the field is required, choose the answer that is
   most probable for this candidate and say in the rationale that it is an
   inference.
3. For open-ended questions ("why this role", "describe a project", "what
   interests you"), write specifically: name the technologies, the scale, and
   the accomplishments from THIS resume, and connect them to THIS posting's
   requirements. No generic filler, no flattery, no invented enthusiasm about
   details not in the posting.
4. Respect the stated format. Choice fields must use an allowed option value
   verbatim. Respect any length limit in the question's description.
5. Write in the candidate's voice, first person, plain and confident. No
   markdown, no bullet characters unless the question asks for a list.

Length guidance: short-text answers under 40 words; long-text answers 80-160
words unless the question says otherwise.`;

interface Question {
  fieldId: string;
  title: string;
  type: string;
  required: boolean;
  description?: string;
  options?: string[];
}

function describeQuestion(q: Question): string {
  const lines = [
    `- fieldId: ${q.fieldId}`,
    `  question: ${q.title || "(untitled field)"}`,
    `  type: ${q.type}`,
    `  required: ${q.required ? "yes" : "no"}`,
  ];
  if (q.description) lines.push(`  note: ${q.description}`);
  if (q.options?.length) {
    lines.push(`  allowed values (use one verbatim): ${q.options.join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * Answer whatever the deterministic pass could not.
 *
 * Batched into a single call: one round-trip for the whole form keeps an
 * application inside a few seconds even when a posting adds five new questions,
 * and it lets the model keep answers consistent with each other.
 */
async function resolveWithLlm(
  pending: AshbyFieldEntry[],
  resume: Resume,
  job: Job,
): Promise<Map<string, { answer: string; rationale: string }>> {
  const questions: Question[] = pending.map((e) => ({
    fieldId: e.field.id,
    title: e.field.title || e.field.humanReadablePath,
    type: e.field.type,
    required: e.isRequired,
    description: e.descriptionHtml
      ? e.descriptionHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : undefined,
    options: (e.field.selectableValues ?? [])
      .filter((o) => !o.isArchived)
      .map((o) => o.value),
  }));

  const profileBlock = resume.profile
    ? `\n\nSTRUCTURED PROFILE\n${JSON.stringify(resume.profile, null, 1)}`
    : "";

  const parsed = await askStructured({
    schema: AnswerSchema,
    name: "application_answers",
    instructions: ANSWER_INSTRUCTIONS,
    // Resume is the stable prefix; it is cached across every job we apply to.
    cachedSystem: `CANDIDATE RESUME\n================\n${truncate(resume.text, 60_000)}${profileBlock}`,
    user: [
      `JOB YOU ARE APPLYING TO`,
      `=======================`,
      `Title: ${job.title}`,
      `Team: ${job.department}${job.team && job.team !== job.department ? ` / ${job.team}` : ""}`,
      `Location: ${job.location}${job.isRemote ? " (remote)" : ""}`,
      `Type: ${job.employmentType}`,
      ``,
      truncate(job.descriptionText, 9000),
      ``,
      `QUESTIONS TO ANSWER`,
      `===================`,
      questions.map(describeQuestion).join("\n"),
      ``,
      `Return one entry per fieldId above.`,
    ].join("\n"),
    maxTokens: 4096,
  });

  const out = new Map<string, { answer: string; rationale: string }>();
  for (const a of parsed.answers) {
    out.set(a.fieldId, { answer: a.answer, rationale: a.rationale });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface ResolveOutcome {
  resolved: ResolvedField[];
  /** Required fields we could not fill; the caller must not submit if non-empty. */
  unanswered: { title: string; type: string; reason: string }[];
  usedLlm: boolean;
}

/**
 * Produce a value for every field on a live form.
 *
 * The form is read fresh from Ashby for each application, so a question added
 * to a posting today is handled today: known fields come from the applicant's
 * saved data, and anything unrecognised goes to the model with the job and the
 * resume in context.
 */
export async function resolveForm(
  form: AshbyFormRender,
  resume: Resume,
  job: Job,
): Promise<ResolveOutcome> {
  const entries = visibleFieldEntries(form);
  const resolved: ResolvedField[] = [];
  const pending: AshbyFieldEntry[] = [];

  for (const entry of entries) {
    const known = resolveKnown(entry, resume);
    if (known && (known.wantsResumeFile || known.value !== null)) {
      resolved.push(known);
    } else {
      pending.push(entry);
    }
  }

  let usedLlm = false;
  if (pending.length > 0 && (await llmReady())) {
    usedLlm = true;
    try {
      const answers = await resolveWithLlm(pending, resume, job);
      for (const entry of pending) {
        const hit = answers.get(entry.field.id);
        if (!hit || !hit.answer.trim()) continue;
        const value = coerceForField(entry.field, hit.answer);
        if (value === null) continue;
        resolved.push({ entry, value, source: "llm", rationale: hit.rationale });
      }
    } catch (err) {
      // Fall through: unanswered required fields are reported below rather than
      // guessed at, so we never submit a half-filled application.
      console.warn(`[fill] LLM answering failed for "${job.title}":`, err);
    }
  }

  // Last resort for a required single-choice field nothing else answered.
  // Ashby forms are overwhelmingly Yes/No, so a recorded default beats failing
  // an otherwise-complete application - but never for a legal-status question,
  // where a guess would put a false statement on a real application.
  for (const entry of pending) {
    if (resolved.some((r) => r.entry.field.id === entry.field.id)) continue;
    if (!entry.isRequired) continue;
    if (isLegalStatusQuestion(entry.field)) continue;
    const opts = (entry.field.selectableValues ?? []).filter((o) => !o.isArchived);
    if (entry.field.type === "ValueSelect" && opts.length > 0) {
      const first = opts[0]!;
      resolved.push({
        entry,
        value: first.value,
        source: "default",
        rationale: `No answer available; defaulted to the first option ("${first.label}").`,
      });
    }
  }

  const answeredIds = new Set(resolved.map((r) => r.entry.field.id));
  const unanswered = entries
    .filter((e) => e.isRequired && !answeredIds.has(e.field.id))
    .map((e) => ({
      title: e.field.title || e.field.path,
      type: e.field.type,
      reason: isLegalStatusQuestion(e.field)
        ? "we will not guess your legal status - set 'Authorized to work' and " +
          "'Needs visa sponsorship' under Applicant details"
        : e.field.type === "File"
          ? "form wants a file we do not have"
          : usedLlm
            ? "model produced no usable answer"
            : "needs an LLM (set OPENAI_API_KEY) or a saved value",
    }));

  return { resolved, unanswered, usedLlm };
}
