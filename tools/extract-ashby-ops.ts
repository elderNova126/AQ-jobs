/**
 * Regenerate `src/ashby/gql-ops.ts` from Ashby's live job-board bundle.
 *
 * Why this exists
 * ---------------
 * Ashby's job board is a Vite app that ships its GraphQL documents as
 * PRE-COMPILED ASTs, not as query strings, and introspection is disabled on the
 * public endpoint. So the only trustworthy source for the exact operations the
 * board sends is the bundle itself.
 *
 * This script walks that path automatically:
 *   1. load a real application page and read the CDN bundle base out of it
 *   2. fetch the Vite manifest and download every JS chunk
 *   3. find each `{kind:'Document',definitions:[...]}` literal, bracket-match it,
 *      evaluate it, and re-print it with graphql-js
 *   4. write the operations we depend on into src/ashby/gql-ops.ts
 *
 * Run it when an application suddenly fails with a GraphQL validation error,
 * which is the signal that Ashby changed their schema or operations:
 *
 *   npx tsx tools/extract-ashby-ops.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { print, type DocumentNode } from "graphql";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "src", "ashby", "gql-ops.ts");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** The operations this project actually uses. */
const WANTED = [
  "ApiJobPosting",
  "ApiSetFormValue",
  "ApiSetFormValueToFile",
  "ApiCreateFileUploadHandle",
  "ApiSubmitSingleApplicationFormAction",
] as const;

/** Any listed AfterQuery posting works; we only need the HTML shell. */
const SEED_PAGE =
  "https://jobs.ashbyhq.com/AfterQuery/f9055979-9c2d-4b5d-a0ec-f248205b1d16/application";

async function get(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.text();
}

/** Find the enclosing `{...}` literal starting at `start`, respecting strings. */
function matchBraces(src: string, start: number): string {
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "`" || c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting a GraphQL document");
}

function extractDocuments(js: string): Map<string, string> {
  const found = new Map<string, string>();
  const marker = "{kind:`Document`,definitions:[";
  let from = 0;
  for (;;) {
    const at = js.indexOf(marker, from);
    if (at < 0) break;
    from = at + 1;
    let literal: string;
    try {
      literal = matchBraces(js, at);
    } catch {
      continue;
    }
    try {
      // The literal is plain data (kind/value/name objects) straight out of the
      // bundle, so evaluating it is how we turn it back into an AST.
      const doc = eval(`(${literal})`) as DocumentNode;
      const opName = doc.definitions
        .filter((d) => d.kind === "OperationDefinition")
        .map((d) => ("name" in d ? d.name?.value : undefined))
        .find(Boolean);
      if (opName) found.set(opName, print(doc));
    } catch {
      /* not a document literal after all */
    }
  }
  return found;
}

async function main(): Promise<void> {
  console.log("· loading application page shell");
  const html = await get(SEED_PAGE);

  const base = html.match(
    /https:\/\/cdn\.ashbyprd\.com\/frontend_non_user\/[a-f0-9]+/,
  )?.[0];
  if (!base) throw new Error("could not find the frontend bundle base URL in the page");
  console.log(`· bundle base: ${base}`);

  const manifest = JSON.parse(await get(`${base}/.vite/manifest.json`)) as Record<
    string,
    { file?: string }
  >;
  const files = [
    ...new Set(
      Object.values(manifest)
        .map((v) => v.file)
        .filter((f): f is string => typeof f === "string" && f.endsWith(".js")),
    ),
  ];
  console.log(`· ${files.length} JS chunk(s)`);

  const all = new Map<string, string>();
  for (const f of files) {
    const js = await get(`${base}/${f}`);
    const docs = extractDocuments(js);
    for (const [k, v] of docs) if (!all.has(k)) all.set(k, v);
    console.log(`  ${f}: ${docs.size} document(s)`);
  }
  console.log(`· ${all.size} operations recovered`);

  const missing = WANTED.filter((w) => !all.has(w));
  if (missing.length) {
    throw new Error(
      `Ashby's bundle no longer contains: ${missing.join(", ")}. ` +
        `Their board changed; inspect the recovered list before regenerating.\n` +
        `Recovered: ${[...all.keys()].sort().join(", ")}`,
    );
  }

  const body = WANTED.map((n) => `  ${n}: ${JSON.stringify(all.get(n))},\n`).join("\n");
  const out = `// AUTO-GENERATED from Ashby's own job-board bundle (frontend_non_user).
// Recovered by decompiling the precompiled GraphQL ASTs, then re-printing with graphql-js.
// These are the exact operations jobs.ashbyhq.com sends, so our requests are wire-identical
// to a real applicant's browser. Do not hand-edit: re-run tools/extract-ashby-ops.ts.

export const ASHBY_OPS = {
${body}} as const;

export type AshbyOpName = keyof typeof ASHBY_OPS;
`;

  fs.writeFileSync(OUT, out, "utf8");
  console.log(`· wrote ${path.relative(process.cwd(), OUT)} (${out.length} bytes)`);
}

main().catch((err: unknown) => {
  console.error("extract-ashby-ops failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
