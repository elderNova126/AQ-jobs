/** ---------- Ashby wire shapes (only the parts we consume) ---------- */

/** The `field` blob on a FormFieldEntry. Ashby ships it as an opaque JSON scalar. */
export interface AshbyFieldDef {
  id: string;
  /** `_systemfield_name` etc. for built-ins; a bare UUID for custom questions. */
  path: string;
  humanReadablePath: string;
  title: string;
  isNullable: boolean;
  isPrivate: boolean;
  isDeactivated: boolean;
  isMany: boolean;
  metadata: Record<string, unknown>;
  type: AshbyFieldType;
  selectableValues?: { label: string; value: string; isArchived?: boolean }[];
  __autoSerializationID?: string;
}

/**
 * Every field type Ashby's form engine can render, taken from the
 * `*Field` serialization IDs in their bundle. We handle all of them so a new
 * question added to a posting tomorrow does not break the agent.
 */
export type AshbyFieldType =
  | "String"
  | "Email"
  | "Phone"
  | "Url"
  | "SocialLink"
  | "LongText"
  | "RichText"
  | "Boolean"
  | "Number"
  | "Currency"
  | "Score"
  | "LinearRating"
  | "NPSRating"
  | "Date"
  | "DateRange"
  | "File"
  | "ValueSelect"
  | "MultiValueSelect"
  | "DimensionSelect"
  | "Location"
  | "EducationHistory"
  | "EmploymentHistory"
  | "CompensationRange"
  | "NumberRange"
  | "Object"
  | "UUID"
  | (string & {});

export interface AshbyFieldEntry {
  id: string;
  field: AshbyFieldDef;
  fieldValue:
    | { value: unknown }
    | { id: string; filename: string }
    | { files: { id: string; filename: string }[] }
    | null;
  isRequired: boolean;
  descriptionHtml: string | null;
  isHidden: boolean | null;
}

export interface AshbyFormRender {
  id: string;
  formControls: { identifier: string; title: string }[];
  errorMessages: string[] | null;
  formErrors: { message: string; fieldEntryId: string | null }[] | null;
  sections: {
    title: string | null;
    descriptionHtml: string | null;
    fieldEntries: AshbyFieldEntry[];
    isHidden: boolean | null;
  }[];
  sourceFormDefinitionId: string | null;
}

export interface AshbyJobPosting {
  id: string;
  title: string;
  departmentName: string | null;
  locationName: string | null;
  workplaceType: string | null;
  employmentType: string | null;
  descriptionHtml: string;
  isListed: boolean;
  teamNames: string[] | null;
  secondaryLocationNames: string[] | null;
  compensationTierSummary: string | null;
  applicationForm: AshbyFormRender;
  automatedProcessingLegalNotice?: {
    automatedProcessingLegalNoticeRuleId: string;
    automatedProcessingLegalNoticeHtml: string;
  } | null;
}

/** ---------- Our domain model ---------- */

/**
 * Which board a job came from. The two have completely different application
 * mechanics, so this decides how (and whether) the agent can apply.
 *  - "ashby"   : the 33 full-time roles behind afterquery.com/careers. Fully
 *                automated end to end.
 *  - "experts" : the 167 contract roles on experts.afterquery.com. Scored and
 *                ranked here; applying happens on their site.
 */
export type JobSource = "ashby" | "experts";

export interface Job {
  id: string;
  source: JobSource;
  title: string;
  department: string;
  team: string;
  location: string;
  isRemote: boolean;
  employmentType: string;
  compensation: string | null;
  applyUrl: string;
  jobUrl: string;
  publishedAt: string | null;
  /** Plain-text description used for scoring and for answering questions. */
  descriptionText: string;
  syncedAt: string;
  /** Experts only: hourly range, talent-pool flag, and required credentials. */
  experts?: {
    isPool: boolean;
    requireAssessment: boolean;
    requireInterview: boolean;
    /** Custom per-job questions Experts asks on top of the standard form. */
    additionalFields: {
      name: string;
      type: string;
      label: string;
      required: boolean;
      description?: string;
      options?: string[];
    }[];
    showGithub: boolean;
    showPortfolio: boolean;
    showCoverLetter: boolean;
    showProgrammingLanguages: boolean;
  };
}

/** Applicant identity. Lives on the resume so each resume can carry its own. */
export interface ResumeIdentity {
  firstName: string;
  lastName: string;
  email: string;
  linkedinUrl: string;
  githubUrl: string;
  phone?: string;
  location?: string;
  websiteUrl?: string;
  /**
   * Work-authorization answers.
   *
   * These are factual claims about the applicant that appear on every
   * AfterQuery posting, so the user owns them rather than the model. `null`
   * means "not stated": we then fall back to what the resume says, and only
   * then to a model inference (recorded with its rationale).
   */
  usAuthorized?: boolean | null;
  needsSponsorship?: boolean | null;
}

/** What the LLM pulls out of the resume text, used for scoring + answering. */
export interface ResumeProfile {
  headline: string;
  yearsExperience: number | null;
  seniority: string;
  skills: string[];
  domains: string[];
  education: string[];
  companies: string[];
  highlights: string[];
  workAuthorization: {
    /** Authorized to work in the US without sponsorship? */
    usAuthorized: boolean | null;
    needsSponsorship: boolean | null;
    evidence: string;
  };
}

export interface Resume {
  id: string;
  label: string;
  isPrimary: boolean;
  fileName: string;
  storedPath: string;
  mimeType: string;
  byteLength: number;
  /** Extracted plain text; the substrate for every LLM call. */
  text: string;
  textChars: number;
  identity: ResumeIdentity;
  profile: ResumeProfile | null;
  createdAt: string;
}

export interface ScoreBreakdown {
  skills: number;
  experience: number;
  domain: number;
  seniority: number;
}

export interface Score {
  resumeId: string;
  jobId: string;
  /** 0-100 overall match. */
  score: number;
  breakdown: ScoreBreakdown;
  verdict: "strong" | "good" | "moderate" | "weak";
  summary: string;
  strengths: string[];
  gaps: string[];
  /** "llm" when Claude scored it, "heuristic" when we fell back. */
  method: "llm" | "heuristic";
  scoredAt: string;
}

export type ApplicationStatus =
  | "queued"
  | "running"
  | "submitted"
  | "dry-run"
  | "failed"
  | "skipped";

export interface ApplicationFieldRecord {
  title: string;
  path: string;
  type: string;
  /** What we actually sent, stringified for display. */
  value: string;
  source: "identity" | "resume-file" | "profile" | "llm" | "default";
  /** Present when the LLM answered an unexpected question. */
  rationale?: string;
}

export interface Application {
  id: string;
  resumeId: string;
  jobId: string;
  jobTitle: string;
  status: ApplicationStatus;
  score: number | null;
  fields: ApplicationFieldRecord[];
  error: string | null;
  /** Wall-clock milliseconds for the whole submit. */
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** ---------- Progress events streamed to the UI over SSE ---------- */

export type ProgressEvent =
  | { kind: "job-sync"; total: number }
  | { kind: "auth-step"; step: string }
  | {
      kind: "auth-done";
      status: {
        signedIn: boolean;
        email: string | null;
        displayName: string | null;
        hasProfile: boolean;
        via: "refresh-token" | "my-chrome" | "your-browser" | "agent-profile" | null;
        reason: "ok" | "never-signed-in" | "signed-out" | "error";
        checkedAt: string;
        detail?: string;
      };
    }
  | {
      kind: "score-start";
      resumeId: string;
      total: number;
    }
  | {
      kind: "score-one";
      resumeId: string;
      jobId: string;
      done: number;
      total: number;
      score: number;
    }
  | { kind: "score-done"; resumeId: string }
  | {
      kind: "apply-start";
      runId: string;
      resumeId: string;
      jobIds: string[];
    }
  | {
      kind: "apply-step";
      runId: string;
      jobId: string;
      jobTitle: string;
      step: string;
    }
  | {
      kind: "apply-one";
      runId: string;
      application: Application;
      done: number;
      total: number;
    }
  | { kind: "apply-done"; runId: string; submitted: number; failed: number }
  | { kind: "error"; message: string };
