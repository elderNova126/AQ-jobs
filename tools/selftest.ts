/**
 * Self-test for the logic that decides what gets typed into a form.
 *
 * The parts that must never regress are the ones that run without a model:
 * type coercion for every Ashby field type, option matching for choice fields,
 * identity gating, resume parsing, and the live board/form contract. A wrong
 * value here is silently accepted by the GraphQL layer and only fails at
 * submit, so it is worth pinning down.
 *
 *   npx tsx tools/selftest.ts
 */

import assert from "node:assert/strict";
import { coerceForField } from "../src/apply/fill.js";
import { missingIdentityFields } from "../src/apply/engine.js";
import { guessIdentity, extractResumeText } from "../src/resume/extract.js";
import { fetchBoard, openApplicationForm, visibleFieldEntries } from "../src/ashby/client.js";
import { fetchExpertsBoard } from "../src/experts/client.js";
import { htmlToText, mapLimit, verdictOf } from "../src/util.js";
import type { AshbyFieldDef, Resume } from "../src/types.js";

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      fail++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

const field = (over: Partial<AshbyFieldDef>): AshbyFieldDef => ({
  id: "f1",
  path: "p1",
  humanReadablePath: "",
  title: "Field",
  isNullable: true,
  isPrivate: false,
  isDeactivated: false,
  isMany: false,
  metadata: {},
  type: "String",
  ...over,
});

const yesNo = [
  { label: "Yes", value: "Yes" },
  { label: "No", value: "No", isArchived: false },
];

async function main(): Promise<void> {
  console.log("\n== type coercion (every Ashby field type) ==");

  await test("String trims", () =>
    assert.equal(coerceForField(field({ type: "String" }), "  Jordan Reyes  "), "Jordan Reyes"));

  await test("Email passes through", () =>
    assert.equal(coerceForField(field({ type: "Email" }), "a@b.com"), "a@b.com"));

  await test("Url / SocialLink / Phone / LongText / RichText -> string", () => {
    for (const t of ["Url", "SocialLink", "Phone", "LongText", "RichText"] as const) {
      assert.equal(coerceForField(field({ type: t }), " x "), "x", `type ${t}`);
    }
  });

  await test("unknown future field type falls back to string", () =>
    assert.equal(coerceForField(field({ type: "SomethingAshbyAddsIn2027" }), "v"), "v"));

  await test("Boolean accepts real booleans and yes/no text", () => {
    assert.equal(coerceForField(field({ type: "Boolean" }), true), true);
    assert.equal(coerceForField(field({ type: "Boolean" }), "Yes"), true);
    assert.equal(coerceForField(field({ type: "Boolean" }), "no"), false);
  });

  await test("Number strips currency and units", () => {
    assert.equal(coerceForField(field({ type: "Number" }), "7"), 7);
    assert.equal(coerceForField(field({ type: "Currency" }), "$185,000"), 185000);
    assert.equal(coerceForField(field({ type: "Number" }), "not a number"), null);
  });

  await test("Score / LinearRating / NPSRating -> number", () => {
    for (const t of ["Score", "LinearRating", "NPSRating"] as const) {
      assert.equal(coerceForField(field({ type: t }), "8"), 8, `type ${t}`);
    }
  });

  await test("Date normalises to YYYY-MM-DD", () => {
    assert.equal(coerceForField(field({ type: "Date" }), "2026-03-01"), "2026-03-01");
    assert.equal(coerceForField(field({ type: "Date" }), "March 1, 2026"), "2026-03-01");
    assert.equal(coerceForField(field({ type: "Date" }), "whenever"), null);
  });

  console.log("\n== choice fields (must match an allowed value exactly) ==");

  const vs = field({ type: "ValueSelect", selectableValues: yesNo });

  await test("exact option value", () => assert.equal(coerceForField(vs, "Yes"), "Yes"));
  await test("case-insensitive", () => assert.equal(coerceForField(vs, "yes"), "Yes"));
  await test("verbose model answer 'Yes, I am authorized' -> Yes", () =>
    assert.equal(coerceForField(vs, "Yes, I am authorized to work in the US"), "Yes"));
  await test("negative phrasing 'No, I will not' -> No", () =>
    assert.equal(coerceForField(vs, "No, I will not require sponsorship"), "No"));
  await test("unmatchable answer -> null (never invents a value)", () =>
    assert.equal(coerceForField(vs, "it depends on the team"), null));

  await test("archived options are never selected", () => {
    const f = field({
      type: "ValueSelect",
      selectableValues: [
        { label: "Legacy", value: "Legacy", isArchived: true },
        { label: "Current", value: "Current", isArchived: false },
      ],
    });
    assert.equal(coerceForField(f, "Legacy"), null);
    assert.equal(coerceForField(f, "Current"), "Current");
  });

  await test("label differing from value resolves to the value", () => {
    const f = field({
      type: "ValueSelect",
      selectableValues: [{ label: "0-2 years", value: "junior" }],
    });
    assert.equal(coerceForField(f, "0-2 years"), "junior");
  });

  await test("MultiValueSelect splits and dedupes to allowed values", () => {
    const f = field({
      type: "MultiValueSelect",
      selectableValues: [
        { label: "Python", value: "Python" },
        { label: "TypeScript", value: "TypeScript" },
        { label: "Rust", value: "Rust" },
      ],
    });
    assert.deepEqual(coerceForField(f, "Python, TypeScript, Python"), ["Python", "TypeScript"]);
    assert.deepEqual(coerceForField(f, ["Rust"]), ["Rust"]);
    assert.equal(coerceForField(f, "Fortran"), null);
  });

  await test("free-text ValueSelect with no options keeps the answer", () =>
    assert.equal(coerceForField(field({ type: "ValueSelect" }), "Anything"), "Anything"));

  console.log("\n== identity gating (what locks the Apply button) ==");

  const base = (over: Partial<Resume["identity"]> = {}): Resume =>
    ({
      identity: {
        firstName: "Jordan",
        lastName: "Reyes",
        email: "a@b.com",
        linkedinUrl: "https://linkedin.com/in/x",
        githubUrl: "https://github.com/x",
        ...over,
      },
    }) as Resume;

  await test("complete identity is ready", () =>
    assert.deepEqual(missingIdentityFields(base()), []));
  await test("missing first name blocks apply", () =>
    assert.deepEqual(missingIdentityFields(base({ firstName: "" })), ["First name"]));
  await test("missing github blocks apply", () =>
    assert.deepEqual(missingIdentityFields(base({ githubUrl: "" })), ["GitHub URL"]));
  await test("whitespace-only counts as missing", () =>
    assert.deepEqual(missingIdentityFields(base({ linkedinUrl: "   " })), ["LinkedIn URL"]));
  await test("all four missing are reported together", () =>
    assert.equal(
      missingIdentityFields(
        base({ firstName: "", lastName: "", linkedinUrl: "", githubUrl: "", email: "" }),
      ).length,
      5,
    ));

  console.log("\n== resume parsing ==");

  await test("identity scrape finds name, email, links, phone", () => {
    const g = guessIdentity(
      "Jordan Avery Reyes\nSan Francisco, CA | jordan@example.com | (415) 555-0142\n" +
        "linkedin.com/in/jordan-reyes | github.com/jordanreyes\n\nSUMMARY\nEngineer.",
    );
    assert.equal(g.firstName, "Jordan");
    assert.equal(g.lastName, "Reyes");
    assert.equal(g.email, "jordan@example.com");
    assert.equal(g.linkedinUrl, "https://linkedin.com/in/jordan-reyes");
    assert.equal(g.githubUrl, "https://github.com/jordanreyes");
    assert.equal(g.phone, "(415) 555-0142");
  });

  await test("scrape skips headings and contact lines when finding the name", () => {
    const g = guessIdentity("RESUME\n\nDana Whitfield\ndana@x.io\n");
    assert.equal(g.firstName, "Dana");
    assert.equal(g.lastName, "Whitfield");
  });

  await test("scrape returns blanks rather than guessing badly", () => {
    const g = guessIdentity("CURRICULUM VITAE\n\n\nSKILLS\nPython, Go\n");
    assert.equal(g.firstName, "");
    assert.equal(g.email, "");
  });

  await test("txt extraction", async () => {
    const r = await extractResumeText(Buffer.from("Hello resume\nSecond line"), "a.txt");
    assert.equal(r.via, "text");
    assert.match(r.text, /Hello resume/);
  });

  await test("unsupported format is rejected with a clear message", async () => {
    await assert.rejects(
      () => extractResumeText(Buffer.from("x"), "resume.pages"),
      /unsupported resume format/i,
    );
  });

  await test("empty file is rejected", async () => {
    await assert.rejects(() => extractResumeText(Buffer.from(""), "a.txt"), /empty/i);
  });

  console.log("\n== utilities ==");

  await test("htmlToText strips tags and decodes entities", () => {
    const t = htmlToText("<h1>Role</h1><p>Build&nbsp;things &amp; ship</p><li>Fast</li>");
    assert.match(t, /Role/);
    assert.match(t, /Build things & ship/);
    assert.match(t, /- Fast/);
    assert.ok(!t.includes("<"), "should contain no tags");
  });

  await test("mapLimit preserves order and respects the cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded 3`);
  });

  await test("verdict thresholds", () => {
    assert.equal(verdictOf(95), "strong");
    assert.equal(verdictOf(80), "strong");
    assert.equal(verdictOf(70), "good");
    assert.equal(verdictOf(50), "moderate");
    assert.equal(verdictOf(20), "weak");
  });

  console.log("\n== live contract against AfterQuery's board ==");

  let firstJobId = "";
  await test("Ashby board returns listed jobs with descriptions", async () => {
    const jobs = await fetchBoard();
    assert.ok(jobs.length > 0, "expected at least one job");
    firstJobId = jobs[0]!.id;
    for (const j of jobs) {
      assert.ok(j.id && j.title, "job needs id and title");
      assert.equal(j.source, "ashby");
      assert.ok(j.descriptionText.length > 200, `"${j.title}" description too short`);
      assert.match(j.applyUrl, /jobs\.ashbyhq\.com/);
    }
    console.log(`       (${jobs.length} jobs)`);
  });

  await test("Experts board is readable without signing in", async () => {
    const jobs = await fetchExpertsBoard(null);
    assert.ok(jobs.length > 50, `expected many Experts roles, got ${jobs.length}`);
    for (const j of jobs) {
      assert.equal(j.source, "experts");
      assert.ok(j.id.startsWith("experts:"), "Experts ids must be namespaced");
      assert.ok(j.experts, "Experts jobs carry their application metadata");
      assert.match(j.applyUrl, /experts\.afterquery\.com/);
    }
    const pools = jobs.filter((j) => j.experts!.isPool).length;
    const cred = jobs.filter((j) => j.experts!.additionalFields.length > 0).length;
    console.log(`       (${jobs.length} roles, ${pools} pools, ${cred} asking extra credentials)`);
  });

  await test("job ids from the two boards cannot collide", async () => {
    const [a, e] = await Promise.all([fetchBoard(), fetchExpertsBoard(null)]);
    const ids = new Set([...a, ...e].map((j) => j.id));
    assert.equal(ids.size, a.length + e.length, "duplicate job id across boards");
  });

  await test("application form exposes a submit control and required fields", async () => {
    const { form } = await openApplicationForm(firstJobId);
    assert.ok(form.id, "form render needs an id");
    assert.ok(form.formControls.length > 0, "form needs a control");
    const entries = visibleFieldEntries(form);
    assert.ok(entries.length > 0, "form needs fields");
    const required = entries.filter((e) => e.isRequired);
    assert.ok(required.length > 0, "expected required fields");
    assert.ok(
      entries.some((e) => e.field.type === "File"),
      "expected a resume file field",
    );
    console.log(
      `       (${entries.length} fields, ${required.length} required: ` +
        `${entries.map((e) => e.field.type).join(", ")})`,
    );
  });

  await test("each form read mints a fresh render session", async () => {
    const a = await openApplicationForm(firstJobId);
    const b = await openApplicationForm(firstJobId);
    assert.notEqual(a.form.id, b.form.id, "render ids must not be reused across applications");
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("selftest crashed:", err);
  process.exit(1);
});
