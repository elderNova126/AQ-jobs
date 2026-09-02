/**
 * AfterQuery Apply Agent - client.
 *
 * Deliberately dependency-free: the whole UI is one state object plus a render
 * pass, which is easier to reason about (and to debug at 2am) than a build
 * pipeline for a single-screen tool.
 */

const $ = (id) => document.getElementById(id);

const state = {
  llmReady: false,
  model: "",
  dryRun: false,
  jobs: [],
  resumes: [],
  applications: [],
  jobsSyncedAt: null,
  /** resumeId -> Map(jobId -> score) */
  scores: new Map(),
  selectedResumeId: null,
  /** jobId -> current step text while an apply is running */
  running: new Map(),
  filters: { q: "", dept: "", source: "", sort: "score" },
  auth: { signedIn: false, email: null, hasProfile: false, detail: "" },
  counts: { ashby: 0, experts: 0 },
  signingIn: false,
  scoring: null,
  applyRun: null,
  usage: null,
};

/* ------------------------------ helpers ------------------------------ */

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body instanceof FormData ? undefined : { "Content-Type": "application/json", ...opts.headers },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

let toastTimer = null;
function toast(msg, kind = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === "err" ? 7000 : 3500);
}

function log(msg, cls = "") {
  const ul = $("log");
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<span class="t">${t}</span><span class="${cls}"></span>`;
  li.lastElementChild.textContent = msg;
  ul.prepend(li);
  while (ul.children.length > 220) ul.lastElementChild.remove();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const selectedResume = () => state.resumes.find((r) => r.id === state.selectedResumeId) ?? null;

const scoreMap = (resumeId) => state.scores.get(resumeId) ?? new Map();

/** Ashby often bakes "(Remote)" into the location already - don't say it twice. */
function locationLabel(job) {
  const loc = job.location ?? "";
  return job.isRemote && !/remote/i.test(loc) ? `${loc} (remote)` : loc;
}

function scoreClass(v) {
  if (v >= 80) return "s-strong";
  if (v >= 65) return "s-good";
  if (v >= 45) return "s-moderate";
  return "s-weak";
}

function scoreColor(v) {
  if (v >= 80) return "var(--strong)";
  if (v >= 65) return "var(--accent)";
  if (v >= 45) return "var(--warn)";
  return "var(--text-faint)";
}

/** Latest application for this resume+job, used for the Status column. */
function latestApp(resumeId, jobId) {
  return state.applications.find((a) => a.resumeId === resumeId && a.jobId === jobId) ?? null;
}

/* ------------------------------ loading ------------------------------ */

async function loadState() {
  const s = await api("/api/state");
  state.llmReady = s.llmReady;
  state.model = s.model;
  state.dryRun = s.dryRun;
  state.jobs = s.jobs;
  state.resumes = s.resumes;
  state.applications = s.applications;
  state.jobsSyncedAt = s.jobsSyncedAt;
  state.auth = s.auth ?? state.auth;
  state.counts = s.counts ?? state.counts;
  state.llmDetail = s.llmDetail ?? "";
  state.usage = s.usage ?? state.usage;

  if (!state.selectedResumeId || !state.resumes.some((r) => r.id === state.selectedResumeId)) {
    const primary = state.resumes.find((r) => r.isPrimary) ?? state.resumes[0];
    state.selectedResumeId = primary?.id ?? null;
  }

  if (state.selectedResumeId) await loadScores(state.selectedResumeId);
  renderAll();
}

async function loadScores(resumeId) {
  try {
    const { scores } = await api(`/api/scores/${resumeId}`);
    state.scores.set(resumeId, new Map(scores.map((s) => [s.jobId, s])));
  } catch {
    state.scores.set(resumeId, new Map());
  }
}

/* ------------------------------ render ------------------------------ */

function renderAll() {
  renderTop();
  renderResumes();
  renderIdentity();
  renderJobs();
  renderBulk();
}

function renderTop() {
  const pill = $("llmPill");
  pill.textContent = state.llmReady ? `LLM · ${state.model}` : "LLM off";
  pill.className = `pill ${state.llmReady ? "pill-ok" : "pill-off"}`;
  pill.title = state.llmReady
    ? "Claude is scoring matches and answering application questions."
    : "Set OPENAI_API_KEY in .env for real match scoring and question answering.";

  $("dryRunPill").hidden = !state.dryRun;

  const u = state.usage;
  const up = $("usagePill");
  if (u && u.calls > 0) {
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const cost = u.priced && u.estCostUsd > 0 ? ` · ~$${u.estCostUsd.toFixed(u.estCostUsd < 1 ? 4 : 2)}` : "";
    up.hidden = false;
    up.textContent = `${fmt(u.totalTokens)} tok${cost}`;
    up.title =
      `${u.calls} LLM calls this session
` +
      `input ${u.inputTokens.toLocaleString()} (${u.cachedInputTokens.toLocaleString()} cached)
` +
      `output ${u.outputTokens.toLocaleString()}
` +
      (u.priced ? `estimated cost ~$${u.estCostUsd} (rates in .env: AQ_PRICE_IN/OUT)` : "set AQ_PRICE_IN/OUT for a cost estimate");
  } else {
    up.hidden = true;
  }

  const when = state.jobsSyncedAt ? new Date(state.jobsSyncedAt).toLocaleString() : "never";
  const c = state.counts;
  $("boardStatus").textContent =
    `${state.jobs.length} open roles (${c.ashby} Ashby · ${c.experts} Experts) · synced ${when}`;

  renderAuth();
}

function renderAuth() {
  const a = state.auth;
  const pill = $("authPill");
  const btn = $("authBtn");

  if (a.signedIn) {
    pill.textContent = `Experts: ${a.email ?? "signed in"}`;
    pill.className = "pill pill-ok";
    pill.title = a.detail ?? "";
    btn.hidden = false;
    btn.textContent = "Sign out";
  } else {
    pill.textContent = "Experts: not signed in";
    pill.className = "pill pill-off";
    pill.title = a.detail ?? "";
    // Sign-in happens in the sidebar card (paste a refresh token), so the
    // header only offers Sign out once a session exists.
    btn.hidden = true;
  }
  renderAuthCard();
}

/** Sidebar card: paste-a-refresh-token sign-in and current status. */
function renderAuthCard() {
  const a = state.auth;
  const chip = $("authChip");
  const note = $("authNote");
  const btns = $("authBtns");

  if (a.signedIn) {
    chip.textContent = "signed in";
    chip.className = "chip chip-ok";
    note.hidden = false;
    note.innerHTML =
      `Signed in as <strong>${esc(a.email ?? "")}</strong> — headless, no browser needed. ` +
      `Fetching the ${state.counts.experts} Experts roles as you.`;
    btns.hidden = true;
    $("pasteForm").hidden = true;
    return;
  }

  chip.textContent = "not signed in";
  chip.className = "chip chip-bad";
  note.hidden = false;
  note.innerHTML =
    `Sign in with a Firebase refresh token to fetch the ${state.counts.experts} ` +
    `Experts roles as you. Works for any account, no browser needed.`;
  // Keep the button visible unless the paste form is already open.
  btns.hidden = !$("pasteForm").hidden;

  if (a.reason === "error" && a.detail) {
    note.innerHTML += `<br /><span class="err">${esc(a.detail)}</span>`;
  }
}

function renderResumes() {
  const ul = $("resumeList");
  ul.innerHTML = "";
  $("resumeCount").textContent = String(state.resumes.length);
  $("resumeEmpty").hidden = state.resumes.length > 0;

  for (const r of state.resumes) {
    const li = document.createElement("li");
    li.className = `resume-item${r.id === state.selectedResumeId ? " active" : ""}`;

    const scored = scoreMap(r.id).size;
    const meta = [
      `${(r.byteLength / 1024).toFixed(0)} KB`,
      scored ? `${scored} scored` : "not scored",
      r.ready ? "ready" : `${r.missing.length} missing`,
    ];

    li.innerHTML = `
      <button class="star ${r.isPrimary ? "on" : ""}" title="${r.isPrimary ? "Primary resume" : "Make primary"}">★</button>
      <span class="resume-main">
        <span class="resume-name">${esc(r.label)}${r.isPrimary ? ' <span class="badge-primary">primary</span>' : ""}</span>
        <span class="resume-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</span>
      </span>
      <button class="del" title="Delete resume">×</button>`;

    li.addEventListener("click", async (e) => {
      if (e.target.closest(".star") || e.target.closest(".del")) return;
      state.selectedResumeId = r.id;
      if (!state.scores.has(r.id)) await loadScores(r.id);
      renderAll();
    });

    li.querySelector(".star").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (r.isPrimary) return;
      await api(`/api/resumes/${r.id}/primary`, { method: "POST" });
      await loadState();
      toast(`"${r.label}" is now your primary resume`, "ok");
    });

    li.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${r.label}" and its ${scored} scores?`)) return;
      await api(`/api/resumes/${r.id}`, { method: "DELETE" });
      state.scores.delete(r.id);
      if (state.selectedResumeId === r.id) state.selectedResumeId = null;
      await loadState();
      log(`deleted resume "${r.label}"`, "warn");
    });

    ul.append(li);
  }
}

function renderIdentity() {
  const r = selectedResume();
  $("identityCard").hidden = !r;
  if (!r) return;

  const form = $("identityForm");
  const id = r.identity;
  form.firstName.value = id.firstName ?? "";
  form.lastName.value = id.lastName ?? "";
  form.email.value = id.email ?? "";
  form.linkedinUrl.value = id.linkedinUrl ?? "";
  form.githubUrl.value = id.githubUrl ?? "";
  form.phone.value = id.phone ?? "";
  form.location.value = id.location ?? "";
  form.websiteUrl.value = id.websiteUrl ?? "";
  form.usAuthorized.value = id.usAuthorized === true ? "true" : id.usAuthorized === false ? "false" : "";
  form.needsSponsorship.value = id.needsSponsorship === true ? "true" : id.needsSponsorship === false ? "false" : "";

  const chip = $("identityState");
  if (r.ready) {
    chip.textContent = "ready to apply";
    chip.className = "chip chip-ok";
  } else {
    chip.textContent = `needs ${r.missing.join(", ")}`;
    chip.className = "chip chip-bad";
  }
}

function visibleJobs() {
  const r = selectedResume();
  const scores = r ? scoreMap(r.id) : new Map();
  const q = state.filters.q.toLowerCase();

  let rows = state.jobs.filter((j) => {
    if (state.filters.source && j.source !== state.filters.source) return false;
    if (state.filters.dept && j.department !== state.filters.dept) return false;
    if (!q) return true;
    return `${j.title} ${j.department} ${j.team} ${j.location}`.toLowerCase().includes(q);
  });

  const scoreOf = (j) => scores.get(j.id)?.score ?? -1;
  if (state.filters.sort === "score") {
    rows.sort((a, b) => scoreOf(b) - scoreOf(a) || a.title.localeCompare(b.title));
  } else if (state.filters.sort === "title") {
    rows.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    rows.sort((a, b) => a.department.localeCompare(b.department) || a.title.localeCompare(b.title));
  }
  return rows;
}

function renderJobs() {
  const r = selectedResume();
  const scores = r ? scoreMap(r.id) : new Map();
  const rows = visibleJobs();

  // Department filter options, populated once from the board.
  const sel = $("deptFilter");
  const depts = [...new Set(state.jobs.map((j) => j.department))].sort();
  if (sel.options.length !== depts.length + 1) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">All departments</option>${depts
      .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}`;
    sel.value = cur;
  }

  $("jobsTitle").textContent = r ? `Job matches · ${esc(r.label)}` : "Job matches";

  const scored = scores.size;
  const llmCount = [...scores.values()].filter((x) => x.method === "llm").length;
  const estCount = scored - llmCount;
  $("scoreStatus").textContent = !r
    ? "Select a resume to see its scores."
    : state.scoring
      ? `Scoring ${state.scoring.done}/${state.scoring.total}…`
      : scored
        ? `${llmCount} LLM-scored` +
          (estCount ? ` · ${estCount} keyword estimates (dimmed; never auto-applied)` : "") +
          (llmCount === 0 ? " — set OPENAI_API_KEY for real scoring" : "")
        : "Not scored yet.";

  $("shownCount").textContent = `${rows.length} of ${state.jobs.length}`;
  $("jobsEmpty").hidden = rows.length > 0;

  const tbody = $("jobRows");
  tbody.innerHTML = "";

  for (const job of rows) {
    const s = scores.get(job.id) ?? null;
    const app = r ? latestApp(r.id, job.id) : null;
    const runningStep = state.running.get(job.id);

    const tr = document.createElement("tr");

    // score
    // Heuristic (keyword) scores are estimates: dimmed, marked "est", and never
    // used for auto-apply. Only LLM-verified scores render at full strength.
    const isEst = s ? s.method !== "llm" : false;
    const scoreCell = s
      ? `<span class="score ${scoreClass(s.score)}${isEst ? " s-est" : ""}"
               title="${isEst ? "keyword estimate - not used for automated apply" : "LLM-assessed match"}">${s.score}<small>${isEst ? " est" : "/100"}</small></span>
         <div class="meter${isEst ? " s-est" : ""}"><i style="width:${s.score}%;background:${scoreColor(s.score)}"></i></div>`
      : `<span class="s-none">—</span>`;

    // status
    let statusCell;
    if (runningStep) {
      statusCell = `<span class="status st-running">${esc(runningStep)}</span>`;
    } else if (app) {
      const label = app.status === "dry-run" ? "dry run" : app.status;
      statusCell = `<span class="status st-${app.status}">${esc(label)}</span>`;
    } else {
      statusCell = `<span class="status st-idle">—</span>`;
    }

    // Both boards get an automated Apply + an Open ↗ link.
    //  - Ashby: Apply submits via the browser (reCAPTCHA); Open ↗ is the posting.
    //  - Experts: Apply submits via REST as the signed-in user; Open ↗ is the
    //    job description. Experts additionally needs an Experts sign-in.
    const isExperts = job.source === "experts";
    const badge = `<span class="srcbadge srcbadge-${job.source}">${isExperts ? "experts" : "ashby"}</span>`;

    let actionCell;
    {
      const needsAuth = isExperts && !state.auth.signedIn;
      const openHref = job.jobUrl;
      const canApply = Boolean(r?.ready) && !needsAuth && !runningStep && !state.applyRun;
      const applyLabel = app?.status === "submitted" ? "Re-apply" : "Apply";
      const applyTitle = !r
        ? "Select a resume first"
        : !r.ready
          ? `Fill in: ${r.missing.join(", ")}`
          : needsAuth
            ? "Sign in to AfterQuery Experts first (sidebar)"
            : app?.status === "submitted"
              ? "Already submitted - click to submit again"
              : `Apply to ${job.title}`;
      actionCell = `
        <div class="rowbtns">
          <button class="btn btn-apply" data-apply ${canApply ? "" : "disabled"} title="${esc(applyTitle)}">${applyLabel}</button>
          <a class="btn btn-open" href="${esc(openHref)}" target="_blank" rel="noopener"
             title="${isExperts ? "Open the job description on AfterQuery Experts" : "Open the posting on Ashby"}">Open ↗</a>
        </div>`;
    }

    tr.innerHTML = `
      <td>${scoreCell}</td>
      <td>
        <div class="role-title"><button data-detail>${esc(job.title)}</button>${badge}</div>
        <div class="role-sub">${esc(job.employmentType)}${job.compensation ? ` · ${esc(job.compensation.split("•")[0].trim())}` : ""}</div>
      </td>
      <td class="dim">${esc(job.department)}</td>
      <td class="dim">${esc(locationLabel(job))}</td>
      <td>${statusCell}</td>
      <td>${actionCell}</td>`;

    tr.querySelector("[data-detail]").addEventListener("click", () => openDrawer(job, s, app));
    tr.querySelector("[data-apply]")?.addEventListener("click", () => applyOne(job));
    tbody.append(tr);
  }
}

/** Reads the min-score box, defaulting rather than letting a blank mean 0. */
function minScoreValue() {
  const raw = Number($("minScore").value);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 70;
}

function renderBulk() {
  const r = selectedResume();
  const min = minScoreValue();
  const scores = r ? scoreMap(r.id) : new Map();
  const skip = $("skipApplied").checked;

  const eligible = state.jobs.filter((j) => {
    // Ashby always; Experts too, but only when signed in to Experts.
    if (j.source === "experts" && !state.auth.signedIn) return false;
    const s = scores.get(j.id);
    if (!s || s.score < min) return false;
    // Keyword estimates never qualify a role for automated submission.
    if (s.method !== "llm") return false;
    if (skip && r && latestApp(r.id, j.id)?.status === "submitted") return false;
    return true;
  });

  const btn = $("bulkApplyBtn");
  const busy = Boolean(state.applyRun);
  btn.disabled = !r?.ready || eligible.length === 0 || busy;
  btn.textContent = busy
    ? "Applying…"
    : eligible.length
      ? `Apply to ${eligible.length} job${eligible.length === 1 ? "" : "s"} (≥ ${min})`
      : `No jobs ≥ ${min}`;
  btn.title = !r
    ? "Select a resume first"
    : !r.ready
      ? `Fill in: ${r.missing.join(", ")}`
      : eligible.length
        ? `${eligible.map((j) => j.title).join(", ")}`
        : !state.auth.signedIn
          ? "Lower the minimum score, or sign in to Experts to include those roles."
          : "Lower the minimum score, or score this resume first.";

  return eligible;
}

/* ------------------------------ drawer ------------------------------ */

function openDrawer(job, score, app) {
  $("drawerTitle").textContent = job.title;
  const parts = [];

  parts.push(`<div class="dsec">
    <h3>Role</h3>
    <table class="kv">
      <tr><th>Team</th><td>${esc(job.department)}${job.team && job.team !== job.department ? ` / ${esc(job.team)}` : ""}</td></tr>
      <tr><th>Location</th><td>${esc(locationLabel(job))}</td></tr>
      <tr><th>Type</th><td>${esc(job.employmentType)}</td></tr>
      ${job.compensation ? `<tr><th>Compensation</th><td>${esc(job.compensation)}</td></tr>` : ""}
      <tr><th>Posting</th><td><a href="${esc(job.jobUrl)}" target="_blank" rel="noopener">${
        job.source === "experts" ? "open on AfterQuery Experts" : "open on Ashby"
      }</a></td></tr>
    </table>
  </div>`);

  if (score) {
    const b = score.breakdown;
    const bar = (label, v) =>
      `<div class="bar-row"><span>${label}</span><span class="track"><i style="width:${v}%;background:${scoreColor(v)}"></i></span><span class="val">${v}</span></div>`;
    parts.push(`<div class="dsec">
      <h3>Match · ${score.score}/100 (${esc(score.verdict)}) · ${esc(score.method)}</h3>
      <p>${esc(score.summary)}</p>
      <div class="bars">
        ${bar("Skills", b.skills)}${bar("Experience", b.experience)}
        ${bar("Domain", b.domain)}${bar("Seniority", b.seniority)}
      </div>
    </div>`);

    if (score.strengths?.length) {
      parts.push(`<div class="dsec"><h3>Strengths</h3><ul>${score.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`);
    }
    if (score.gaps?.length) {
      parts.push(`<div class="dsec"><h3>Gaps</h3><ul>${score.gaps.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`);
    }
  }

  if (app) {
    // `error` doubles as the explanation for skipped/dry-run outcomes, which
    // are not failures - only paint it red when it actually is one.
    const note = app.error
      ? app.status === "failed"
        ? `<div class="errbox">${esc(app.error)}</div>`
        : `<p class="hint">${esc(app.error)}</p>`
      : "";
    parts.push(`<div class="dsec">
      <h3>Last application · ${esc(app.status)}${app.durationMs ? ` · ${(app.durationMs / 1000).toFixed(1)}s` : ""}</h3>
      ${note}
      ${app.fields?.length ? `<table class="kv">${app.fields.map((f) => `
        <tr><th>${esc(f.title)}</th><td>${esc(f.value)}
          <span class="src src-${esc(f.source)}">${esc(f.source)}</span>
          ${f.rationale ? `<div class="rationale">${esc(f.rationale)}</div>` : ""}
        </td></tr>`).join("")}</table>` : ""}
    </div>`);
  }

  if (job.source === "experts" && job.experts) {
    const e = job.experts;
    const flags = [
      e.isPool ? "talent pool" : "individual role",
      e.requireAssessment ? "assessment required" : null,
      e.requireInterview ? "interview required" : null,
      e.showGithub ? "asks for GitHub" : null,
      e.showPortfolio ? "asks for portfolio" : null,
      e.showCoverLetter ? "asks for cover letter" : null,
    ].filter(Boolean);
    parts.push(`<div class="dsec">
      <h3>Experts application</h3>
      <p class="hint">${esc(flags.join(" · "))}</p>
      ${e.additionalFields.length
        ? `<table class="kv">${e.additionalFields.map((f) => `
            <tr><th>${esc(f.label)}</th><td>${esc(f.type)}${f.required ? " · required" : ""}
              ${f.description ? `<div class="rationale">${esc(f.description)}</div>` : ""}
            </td></tr>`).join("")}</table>`
        : `<p class="hint small">No extra questions beyond the standard form.</p>`}
      <p class="hint small">Automated apply covers the Ashby board only —
        <a href="${esc(job.applyUrl)}" target="_blank" rel="noopener">open this role on AfterQuery Experts</a>.</p>
    </div>`);
  }

  parts.push(`<div class="dsec"><h3>Description</h3><div class="desc">${esc(job.descriptionText)}</div></div>`);

  $("drawerBody").innerHTML = parts.join("");
  $("drawer").hidden = false;
  $("drawerBackdrop").hidden = false;
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawerBackdrop").hidden = true;
}

/* ------------------------------ actions ------------------------------ */

async function uploadFiles(files) {
  const dz = $("dropzone");
  dz.classList.add("busy");
  try {
    for (const file of files) {
      log(`uploading ${file.name}…`);
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await api("/api/resumes", { method: "POST", body: fd });
        const e = res.extraction;
        log(`parsed ${file.name} (${e.via}${e.pages ? `, ${e.pages}p` : ""}, ${e.chars} chars)`, "ok");
        state.selectedResumeId = res.resume.id;
        toast(`"${res.resume.label}" uploaded - scoring against ${state.jobs.length} jobs`, "ok");
      } catch (err) {
        log(`failed ${file.name}: ${err.message}`, "err");
        toast(`${file.name}: ${err.message}`, "err");
      }
    }
    await loadState();
  } finally {
    dz.classList.remove("busy");
  }
}

async function applyOne(job) {
  const r = selectedResume();
  if (!r?.ready) return;
  const app = latestApp(r.id, job.id);
  if (app?.status === "submitted" && !confirm(`You already submitted "${r.label}" to ${job.title}. Submit again?`)) return;

  state.applyRun = { total: 1, done: 0 };
  renderBulk();
  try {
    await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({ resumeId: r.id, jobIds: [job.id], skipAlreadyApplied: false }),
    });
    log(`applying to ${job.title}…`);
  } catch (err) {
    state.applyRun = null;
    toast(err.message, "err");
    log(`apply failed: ${err.message}`, "err");
    renderAll();
  }
}

async function applyBulk() {
  const r = selectedResume();
  if (!r?.ready) return;
  const eligible = renderBulk();
  const min = minScoreValue();
  if (!eligible.length) return;

  const preview = eligible.slice(0, 8).map((j) => `· ${j.title}`).join("\n");
  const more = eligible.length > 8 ? `\n…and ${eligible.length - 8} more` : "";
  const verb = state.dryRun ? "Dry-run" : "Submit";
  if (!confirm(`${verb} ${eligible.length} application${eligible.length === 1 ? "" : "s"} with "${r.label}" (score ≥ ${min}):\n\n${preview}${more}`)) return;

  state.applyRun = { total: eligible.length, done: 0 };
  renderBulk();
  try {
    const res = await api("/api/apply", {
      method: "POST",
      body: JSON.stringify({
        resumeId: r.id,
        minScore: min,
        skipAlreadyApplied: $("skipApplied").checked,
      }),
    });
    log(`bulk apply: ${res.accepted} job(s) queued`, "ok");
  } catch (err) {
    state.applyRun = null;
    toast(err.message, "err");
    log(`bulk apply failed: ${err.message}`, "err");
    renderAll();
  }
}

function setProgress(done, total, label) {
  const wrap = $("progressWrap");
  if (total <= 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("progressFill").style.width = `${Math.round((done / total) * 100)}%`;
  $("progressText").textContent = `${label} ${done}/${total}`;
}

/* ------------------------------ SSE ------------------------------ */

function connectEvents() {
  const es = new EventSource("/api/events");

  es.onmessage = async (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }

    switch (e.kind) {
      case "job-sync":
        log(`board synced: ${e.total} roles`, "ok");
        break;

      case "auth-step":
        log(e.step);
        break;

      case "auth-done":
        state.signingIn = false;
        state.auth = e.status;
        renderAuth();
        break;

      case "score-start":
        state.scoring = { resumeId: e.resumeId, done: 0, total: e.total };
        setProgress(0, e.total, "Scoring");
        log(`scoring against ${e.total} jobs…`);
        break;

      case "score-one": {
        state.scoring = { resumeId: e.resumeId, done: e.done, total: e.total };
        setProgress(e.done, e.total, "Scoring");
        // Keep the table live for the resume currently on screen.
        if (e.resumeId === state.selectedResumeId) {
          if (e.done % 4 === 0 || e.done === e.total) {
            await loadScores(e.resumeId);
            renderJobs();
            renderBulk();
          }
        }
        $("scoreStatus").textContent = `Scoring ${e.done}/${e.total}…`;
        break;
      }

      case "score-done":
        state.scoring = null;
        setProgress(0, 0, "");
        await loadScores(e.resumeId);
        await loadState();
        log("scoring complete", "ok");
        toast("Scoring complete", "ok");
        break;

      case "apply-start":
        state.applyRun = { total: e.jobIds.length, done: 0 };
        setProgress(0, e.jobIds.length, "Applying");
        break;

      case "apply-step":
        state.running.set(e.jobId, e.step);
        renderJobs();
        break;

      case "apply-one": {
        const a = e.application;
        state.running.delete(a.jobId);
        state.applyRun = { total: e.total, done: e.done };
        setProgress(e.done, e.total, "Applying");

        const cls = a.status === "submitted" || a.status === "dry-run" ? "ok"
          : a.status === "failed" ? "err" : "warn";
        const secs = a.durationMs ? ` in ${(a.durationMs / 1000).toFixed(1)}s` : "";
        log(`${a.status}: ${a.jobTitle}${secs}${a.error ? ` - ${a.error}` : ""}`, cls);

        state.applications = [a, ...state.applications.filter((x) => x.id !== a.id)];
        renderJobs();
        break;
      }

      case "apply-done":
        state.applyRun = null;
        state.running.clear();
        setProgress(0, 0, "");
        await loadState();
        log(`apply run finished: ${e.submitted} ok, ${e.failed} failed`, e.failed ? "warn" : "ok");
        toast(`Done: ${e.submitted} submitted, ${e.failed} failed`, e.failed ? "err" : "ok");
        break;

      case "error":
        log(e.message, "err");
        toast(e.message, "err");
        break;
    }
  };

  es.onerror = () => log("event stream dropped - retrying…", "warn");
}

/* ------------------------------ wiring ------------------------------ */

function wire() {
  const dz = $("dropzone");
  const input = $("fileInput");

  dz.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files?.length) uploadFiles([...input.files]);
    input.value = "";
  });

  for (const ev of ["dragenter", "dragover"]) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); });
  }
  dz.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) uploadFiles(files);
  });

  $("identityForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = selectedResume();
    if (!r) return;
    const f = e.target;
    const tri = (v) => (v === "true" ? true : v === "false" ? false : null);
    try {
      await api(`/api/resumes/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          identity: {
            firstName: f.firstName.value,
            lastName: f.lastName.value,
            email: f.email.value,
            linkedinUrl: f.linkedinUrl.value,
            githubUrl: f.githubUrl.value,
            phone: f.phone.value,
            location: f.location.value,
            websiteUrl: f.websiteUrl.value,
            usAuthorized: tri(f.usAuthorized.value),
            needsSponsorship: tri(f.needsSponsorship.value),
          },
        }),
      });
      await loadState();
      const flag = $("savedFlag");
      flag.hidden = false;
      setTimeout(() => { flag.hidden = true; }, 1800);
    } catch (err) {
      toast(err.message, "err");
    }
  });

  // Live-enable Apply as the user types, before they even save.
  $("identityForm").addEventListener("input", () => {
    const r = selectedResume();
    if (!r) return;
    const f = $("identityForm");
    const filled = ["firstName", "lastName", "email", "linkedinUrl", "githubUrl"]
      .every((k) => f[k].value.trim().length > 0);
    const chip = $("identityState");
    if (filled && !r.ready) {
      chip.textContent = "save to unlock apply";
      chip.className = "chip chip-bad";
    }
  });

  // The header button is Sign-out only; sign-in is the paste form in the card.
  $("authBtn").addEventListener("click", async () => {
    if (!state.auth.signedIn) return;
    if (!confirm("Sign out of AfterQuery Experts? This clears the stored token.")) return;
    await api("/api/auth/signout", { method: "POST" });
    await loadState();
    log("signed out of Experts", "warn");
  });

  $("pasteTokenBtn").addEventListener("click", () => {
    const f = $("pasteForm");
    f.hidden = false;
    $("authBtns").hidden = true;
    f.refreshToken.focus();
  });
  $("pasteCancel").addEventListener("click", () => {
    $("pasteForm").hidden = true;
    renderAuthCard();
  });
  $("pasteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const refreshToken = f.refreshToken.value.trim();
    if (!refreshToken) { toast("Paste a refresh token first", "err"); return; }
    log("storing refresh token…");
    try {
      const st = await api("/api/auth/refresh-token", {
        method: "POST",
        body: JSON.stringify({ refreshToken, apiKey: f.apiKey.value.trim() || undefined }),
      });
      if (st.signedIn) {
        toast(`Signed in as ${st.email} — headless, no browser needed`, "ok");
        log(`refresh token stored: ${st.email}`, "ok");
        f.reset();
        $("pasteForm").hidden = true;
      } else {
        toast(st.detail || "Token rejected", "err");
        log(st.detail || "refresh token rejected", "err");
      }
      await loadState();
    } catch (err) {
      toast(err.message, "err");
      log(`paste failed: ${err.message}`, "err");
    }
  });

  $("sourceFilter").addEventListener("change", (e) => {
    state.filters.source = e.target.value;
    renderJobs();
    renderBulk();
  });

  $("syncBtn").addEventListener("click", async () => {
    $("syncBtn").disabled = true;
    try {
      const res = await api("/api/jobs/sync", { method: "POST" });
      await loadState();
      toast(`Synced ${res.total} roles (${res.ashby} Ashby + ${res.experts} Experts)`, "ok");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      $("syncBtn").disabled = false;
    }
  });

  $("bulkApplyBtn").addEventListener("click", applyBulk);

  $("search").addEventListener("input", (e) => {
    state.filters.q = e.target.value;
    renderJobs();
  });
  $("deptFilter").addEventListener("change", (e) => {
    state.filters.dept = e.target.value;
    renderJobs();
  });
  $("sortBy").addEventListener("change", (e) => {
    state.filters.sort = e.target.value;
    renderJobs();
  });
  $("minScore").addEventListener("input", renderBulk);
  $("skipApplied").addEventListener("change", renderBulk);

  $("clearLog").addEventListener("click", () => { $("log").innerHTML = ""; });
  $("drawerClose").addEventListener("click", closeDrawer);
  $("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
}

/* ------------------------------ boot ------------------------------ */

wire();
connectEvents();
loadState().catch((err) => {
  toast(`Could not load state: ${err.message}`, "err");
  log(err.message, "err");
});
