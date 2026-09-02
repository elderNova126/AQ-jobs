import fs from "node:fs";
import path from "node:path";
import { CONFIG, ensureDirs } from "./config.js";
import type { Application, Job, Resume, Score } from "./types.js";
import { nowIso } from "./util.js";

interface StoreShape {
  version: 1;
  jobsSyncedAt: string | null;
  jobs: Record<string, Job>;
  resumes: Record<string, Resume>;
  /** Keyed `${resumeId}:${jobId}` so a lookup is O(1) from either side. */
  scores: Record<string, Score>;
  applications: Record<string, Application>;
}

const empty = (): StoreShape => ({
  version: 1,
  jobsSyncedAt: null,
  jobs: {},
  resumes: {},
  scores: {},
  applications: {},
});

export const scoreKey = (resumeId: string, jobId: string): string =>
  `${resumeId}:${jobId}`;

/**
 * A tiny persisted document store.
 *
 * The whole dataset here is a handful of resumes, ~33 jobs and their scores, so
 * a single JSON document held in memory and flushed atomically is the right
 * amount of machinery. Writes go to a temp file and are renamed, which is
 * atomic on NTFS, so a crash mid-write cannot corrupt the store or lose the
 * "already applied" history.
 */
class Store {
  private data: StoreShape = empty();
  private flushTimer: NodeJS.Timeout | null = null;
  private writing = false;
  private dirtyWhileWriting = false;

  load(): void {
    ensureDirs();
    if (!fs.existsSync(CONFIG.storeFile)) {
      this.data = empty();
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.storeFile, "utf8")) as StoreShape;
      this.data = { ...empty(), ...parsed };
    } catch (err) {
      // Never lose data to a parse error: park the bad file and start clean.
      const bak = `${CONFIG.storeFile}.corrupt-${Date.now()}`;
      fs.renameSync(CONFIG.storeFile, bak);
      console.error(`[store] unreadable, moved to ${path.basename(bak)}:`, err);
      this.data = empty();
    }
  }

  /** Debounced so a 33-job scoring run does not trigger 33 disk writes. */
  private markDirty(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 120);
  }

  async flush(): Promise<void> {
    if (this.writing) {
      this.dirtyWhileWriting = true;
      return;
    }
    this.writing = true;
    try {
      const tmp = `${CONFIG.storeFile}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 1), "utf8");
      await fs.promises.rename(tmp, CONFIG.storeFile);
    } catch (err) {
      console.error("[store] flush failed:", err);
    } finally {
      this.writing = false;
      if (this.dirtyWhileWriting) {
        this.dirtyWhileWriting = false;
        this.markDirty();
      }
    }
  }

  /** Force a synchronous write; used on shutdown. */
  flushSync(): void {
    try {
      const tmp = `${CONFIG.storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), "utf8");
      fs.renameSync(tmp, CONFIG.storeFile);
    } catch (err) {
      console.error("[store] sync flush failed:", err);
    }
  }

  /* ---------------- jobs ---------------- */

  replaceJobs(jobs: Job[]): void {
    this.data.jobs = {};
    for (const j of jobs) this.data.jobs[j.id] = j;
    this.data.jobsSyncedAt = nowIso();
    this.markDirty();
  }

  listJobs(): Job[] {
    return Object.values(this.data.jobs).sort(
      (a, b) =>
        a.department.localeCompare(b.department) || a.title.localeCompare(b.title),
    );
  }

  getJob(id: string): Job | undefined {
    return this.data.jobs[id];
  }

  jobsSyncedAt(): string | null {
    return this.data.jobsSyncedAt;
  }

  /* ---------------- resumes ---------------- */

  putResume(r: Resume): void {
    // First resume uploaded becomes the primary automatically.
    if (Object.keys(this.data.resumes).length === 0) r.isPrimary = true;
    this.data.resumes[r.id] = r;
    this.markDirty();
  }

  updateResume(id: string, patch: Partial<Resume>): Resume | undefined {
    const cur = this.data.resumes[id];
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.data.resumes[id] = next;
    this.markDirty();
    return next;
  }

  setPrimary(id: string): void {
    for (const r of Object.values(this.data.resumes)) r.isPrimary = r.id === id;
    this.markDirty();
  }

  listResumes(): Resume[] {
    return Object.values(this.data.resumes).sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  getResume(id: string): Resume | undefined {
    return this.data.resumes[id];
  }

  deleteResume(id: string): boolean {
    const r = this.data.resumes[id];
    if (!r) return false;
    delete this.data.resumes[id];
    for (const key of Object.keys(this.data.scores)) {
      if (key.startsWith(`${id}:`)) delete this.data.scores[key];
    }
    if (r.isPrimary) {
      const next = Object.values(this.data.resumes)[0];
      if (next) next.isPrimary = true;
    }
    fs.promises.rm(r.storedPath, { force: true }).catch(() => {});
    this.markDirty();
    return true;
  }

  /* ---------------- scores ---------------- */

  putScore(s: Score): void {
    this.data.scores[scoreKey(s.resumeId, s.jobId)] = s;
    this.markDirty();
  }

  getScore(resumeId: string, jobId: string): Score | undefined {
    return this.data.scores[scoreKey(resumeId, jobId)];
  }

  scoresForResume(resumeId: string): Score[] {
    return Object.values(this.data.scores).filter((s) => s.resumeId === resumeId);
  }

  /* ---------------- applications ---------------- */

  putApplication(a: Application): void {
    this.data.applications[a.id] = a;
    this.markDirty();
  }

  listApplications(): Application[] {
    return Object.values(this.data.applications).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /**
   * Idempotency guard: has this resume already been successfully submitted to
   * this job? Prevents a bulk run from double-applying, which would look
   * careless to a recruiter.
   */
  hasSubmitted(resumeId: string, jobId: string): boolean {
    return Object.values(this.data.applications).some(
      (a) => a.resumeId === resumeId && a.jobId === jobId && a.status === "submitted",
    );
  }

  /** Any successful submit for this job, from any resume. */
  submittedJobIds(): Set<string> {
    const out = new Set<string>();
    for (const a of Object.values(this.data.applications)) {
      if (a.status === "submitted") out.add(a.jobId);
    }
    return out;
  }
}

export const store = new Store();
