import { z } from "zod";
import { CONFIG } from "./config.js";
import { askStructured, llmReady } from "./llm.js";
import { store } from "./store.js";
import type { Job, ProgressEvent, Resume, Score } from "./types.js";
import { clamp, errMsg, mapLimit, nowIso, truncate, verdictOf } from "./util.js";

const ScoreSchema = z.object({
  score: z
    .number()
    .describe("0-100 overall fit. Calibrate: 85+ = would clearly interview, 70-84 = solid, 50-69 = plausible stretch, <50 = poor fit"),
  breakdown: z.object({
    skills: z.number().describe("0-100: required technical skills present"),
    experience: z.number().describe("0-100: years and depth vs what the role needs"),
    domain: z.number().describe("0-100: relevant problem-domain/industry overlap"),
    seniority: z.number().describe("0-100: level match; penalise both under- and over-qualification"),
  }),
  summary: z.string().describe("One or two sentences a recruiter could read aloud"),
  strengths: z.array(z.string()).describe("2-5 specific, evidence-backed reasons this candidate fits"),
  gaps: z.array(z.string()).describe("1-4 concrete gaps or risks. Say 'none material' only if truly none."),
});

const INSTRUCTIONS = `You are a rigorous technical recruiter scoring one candidate against one job.

Score honestly and with spread - if everything comes out 70-80 the ranking is
useless. Anchor on the job's hard requirements first, then depth of evidence in
the resume.

Rules:
- Judge only from resume evidence. Do not assume unstated skills.
- Weigh explicit requirements ("must have", "N+ years", named technologies)
  above nice-to-haves.
- Penalise a real seniority mismatch in BOTH directions: a principal engineer
  applying to an internship is a weak match, not a strong one.
- Location/onsite expectations are a factor but never the dominant one.
- strengths and gaps must cite something concrete from the resume or the posting.
- Keep the overall score consistent with the breakdown; it is a judged
  weighting, not a strict average.`;

/** Compact job view for the prompt. Full descriptions are long and repetitive. */
function jobPrompt(job: Job): string {
  return [
    `TITLE: ${job.title}`,
    `DEPARTMENT: ${job.department}${job.team && job.team !== job.department ? ` / ${job.team}` : ""}`,
    `LOCATION: ${job.location}${job.isRemote ? " (remote)" : ""}`,
    `TYPE: ${job.employmentType}`,
    job.compensation ? `COMPENSATION: ${job.compensation}` : "",
    "",
    "DESCRIPTION",
    "-----------",
    truncate(job.descriptionText, 9000),
  ]
    .filter(Boolean)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Heuristic fallback (no API key)
 * ------------------------------------------------------------------ */

const STOP = new Set(
  ("and the for with you are our this that will have from your who all can has was not " +
    "but they their them its also more work team role about into across within using help " +
    "make build we us a an to of in on at as is be or by it if so join looking experience " +
    "years strong ability including etc what when where how been being do does did i me my " +
    "he she who whom while each other than then there these those such very much many")
    .split(" "),
);

function termsOf(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9+#./ -]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && w.length < 24 && !STOP.has(w)),
  );
}

/**
 * Years of experience without the model.
 *
 * Prefers an explicit claim ("7 years"), otherwise infers from the earliest
 * plausible year mentioned. Only used by the heuristic path.
 */
function estimateYears(text: string): number | null {
  const claim = text.match(/(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+(?:professional\s+)?experience/i);
  if (claim?.[1]) {
    const n = Number(claim[1]);
    if (n > 0 && n < 50) return n;
  }
  const thisYear = new Date().getFullYear();
  const years = [...text.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1985 && y <= thisYear);
  if (years.length === 0) return null;
  const earliest = Math.min(...years);
  const span = thisYear - earliest;
  return span > 0 && span < 50 ? span : null;
}

/**
 * Deterministic fallback so the product still works with no API key.
 *
 * Scored across the whole board at once, which is what makes it usable: every
 * AfterQuery posting repeats the same long "About AfterQuery" section, so plain
 * token overlap is dominated by boilerplate and collapses the range. Weighting
 * each term by inverse document frequency across the 33 postings cancels the
 * shared text out and leaves the distinctive requirements (Kubernetes, PyTorch,
 * "RL environments") doing the work — roughly 5x more separation in practice.
 *
 * It is still only a keyword proxy, and both the UI and the summary label it as
 * such. The real assessment is the LLM path.
 */
export function heuristicScoreAll(resume: Resume, jobs: Job[]): Score[] {
  const resumeText = resume.text.toLowerCase();
  const jobTermSets = jobs.map((j) => termsOf(`${j.title} ${j.descriptionText}`));

  // IDF per BOARD, not across the mixed corpus. Ashby and Experts postings use
  // very different vocabularies; pooling them lets each board's shared
  // boilerplate look "distinctive" relative to the other and inflates scores
  // for unrelated roles (a software resume once estimated 70+ for "Dentist").
  const groups = new Map<string, { df: Map<string, number>; n: number }>();
  jobs.forEach((j, i) => {
    const g = groups.get(j.source) ?? { df: new Map<string, number>(), n: 0 };
    g.n++;
    for (const w of jobTermSets[i]!) g.df.set(w, (g.df.get(w) ?? 0) + 1);
    groups.set(j.source, g);
  });
  const idfFor = (source: string) => {
    const g = groups.get(source)!;
    return (w: string): number => Math.log((g.n + 1) / ((g.df.get(w) ?? 0) + 0.5));
  };

  const years = resume.profile?.yearsExperience ?? estimateYears(resume.text);

  return jobs.map((job, i) => {
    const set = jobTermSets[i]!;
    const idf = idfFor(job.source);
    let matched = 0;
    let total = 0;
    let hits = 0;
    for (const w of set) {
      const weight = idf(w);
      total += weight;
      if (resumeText.includes(w)) {
        matched += weight;
        hits++;
      }
    }
    const coverage = total > 0 ? matched / total : 0;

    // Calibrated against the live board: a resume can only ever cover a
    // fraction of a posting's vocabulary, so ~0.19 coverage is a strong match
    // and ~0.03 is unrelated. 430 puts those at ~83 and ~13.
    let score = clamp(Math.round(coverage * 430), 3, 96);

    const wantsIntern = /\bintern\b/i.test(job.title);
    const wantsSenior = /\b(senior|staff|principal|head of|lead|director)\b/i.test(job.title);
    if (years !== null) {
      if (wantsIntern && years >= 4) score -= 28;
      if (wantsSenior && years < 4) score -= 22;
      if (wantsSenior && years >= 6) score += 5;
    }
    score = clamp(score, 3, 96);

    return {
      resumeId: resume.id,
      jobId: job.id,
      score,
      breakdown: {
        skills: score,
        experience: clamp(score - 4, 0, 100),
        domain: clamp(score - 8, 0, 100),
        seniority: clamp(score + 2, 0, 100),
      },
      verdict: verdictOf(score),
      summary:
        `Keyword estimate: matched ${hits} of ${set.size} distinctive posting terms ` +
        `(IDF-weighted coverage ${(coverage * 100).toFixed(1)}%). ` +
        `Set OPENAI_API_KEY for a real match assessment.`,
      strengths: [],
      gaps: [],
      method: "heuristic" as const,
      scoredAt: nowIso(),
    };
  });
}

async function llmScore(resume: Resume, job: Job): Promise<Score> {
  const profileBlock = resume.profile
    ? `\n\nEXTRACTED PROFILE (for reference; the resume text above is authoritative)\n${JSON.stringify(resume.profile, null, 1)}`
    : "";

  const parsed = await askStructured({
    schema: ScoreSchema,
    name: "job_match",
    instructions: INSTRUCTIONS,
    // Stable across every job in this run -> served from cache after call 1.
    cachedSystem: `CANDIDATE RESUME\n================\n${truncate(resume.text, 60_000)}${profileBlock}`,
    user: `Score this candidate against the following job.\n\n${jobPrompt(job)}`,
    maxTokens: 3000,
    effort: "low",
  });

  const score = clamp(Math.round(parsed.score), 0, 100);
  return {
    resumeId: resume.id,
    jobId: job.id,
    score,
    breakdown: {
      skills: clamp(Math.round(parsed.breakdown.skills), 0, 100),
      experience: clamp(Math.round(parsed.breakdown.experience), 0, 100),
      domain: clamp(Math.round(parsed.breakdown.domain), 0, 100),
      seniority: clamp(Math.round(parsed.breakdown.seniority), 0, 100),
    },
    verdict: verdictOf(score),
    summary: parsed.summary,
    strengths: parsed.strengths,
    gaps: parsed.gaps,
    method: "llm",
    scoredAt: nowIso(),
  };
}

/**
 * Score one resume against every job, writing each result as it lands so the UI
 * fills in progressively instead of waiting for the whole batch.
 */
export async function scoreResumeAgainstAllJobs(
  resume: Resume,
  jobs: Job[],
  emit: (e: ProgressEvent) => void,
): Promise<{ scored: number; method: "llm" | "heuristic" }> {
  const useLlm = await llmReady();
  // total is set below once we know how many get a real assessment.

  // Computed up front: the heuristic needs the whole board to weight terms, and
  // it doubles as the per-job fallback if an individual LLM call fails.
  const fallback = new Map(
    heuristicScoreAll(resume, jobs).map((s) => [s.jobId, s] as const),
  );

  // Rank by the free heuristic first, then spend the model's attention on the
  // most promising roles. With two boards this is ~206 candidates, and a real
  // assessment of the bottom 120 changes no decision the user would make.
  const limit = CONFIG.llm.scoreLimit;
  const ranked = [...jobs].sort(
    (a, b) => (fallback.get(b.id)?.score ?? 0) - (fallback.get(a.id)?.score ?? 0),
  );
  const deep = new Set(
    useLlm ? ranked.slice(0, limit > 0 ? limit : ranked.length).map((j) => j.id) : [],
  );

  // Persist the heuristic for everything up front so the table fills instantly
  // and nothing is ever blank while the model works through the shortlist.
  for (const s of fallback.values()) store.putScore(s);
  emit({ kind: "score-start", resumeId: resume.id, total: deep.size || jobs.length });

  let done = 0;
  // Score the first job alone so the prompt cache is populated before the rest
  // fan out; otherwise N concurrent calls all miss the cache simultaneously.
  const ordered = ranked.filter((j) => deep.has(j.id));
  const first = ordered.shift();

  const runOne = async (job: Job): Promise<void> => {
    let result: Score;
    try {
      result = await llmScore(resume, job);
    } catch (err) {
      console.warn(`[score] LLM failed for "${job.title}": ${errMsg(err)}`);
      result = fallback.get(job.id)!;
    }
    store.putScore(result);
    done++;
    emit({
      kind: "score-one",
      resumeId: resume.id,
      jobId: job.id,
      done,
      total: deep.size,
      score: result.score,
    });
  };

  if (first) await runOne(first);
  await mapLimit(ordered, CONFIG.llm.scoreConcurrency, runOne);

  await store.flush();
  emit({ kind: "score-done", resumeId: resume.id });
  return { scored: useLlm ? done : jobs.length, method: useLlm ? "llm" : "heuristic" };
}
