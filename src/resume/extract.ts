import path from "node:path";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { errMsg } from "../util.js";

export interface ExtractResult {
  text: string;
  /** How we got the text; surfaced in the UI so a bad parse is visible. */
  via: "pdf" | "docx" | "text";
  pages?: number;
}

/**
 * Turn an uploaded resume into plain text.
 *
 * Everything downstream — scoring, question answering, profile extraction —
 * reads this text, so a silent failure here would poison every match. We throw
 * loudly instead of returning an empty string.
 */
export async function extractResumeText(
  bytes: Buffer,
  filename: string,
): Promise<ExtractResult> {
  const ext = path.extname(filename).toLowerCase();

  if (ext === ".pdf") {
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      const merged = (Array.isArray(text) ? text.join("\n") : text).trim();
      if (!merged) {
        throw new Error(
          "no selectable text found - this looks like a scanned/image-only PDF",
        );
      }
      return { text: normalise(merged), via: "pdf", pages: totalPages };
    } catch (err) {
      throw new Error(`could not read PDF: ${errMsg(err)}`);
    }
  }

  if (ext === ".docx") {
    try {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      const text = value.trim();
      if (!text) throw new Error("document contained no text");
      return { text: normalise(text), via: "docx" };
    } catch (err) {
      throw new Error(`could not read DOCX: ${errMsg(err)}`);
    }
  }

  if (ext === ".txt" || ext === ".md" || ext === ".rtf") {
    const text = bytes.toString("utf8");
    const cleaned = ext === ".rtf" ? stripRtf(text) : text;
    if (!cleaned.trim()) throw new Error("file was empty");
    return { text: normalise(cleaned), via: "text" };
  }

  // .doc (legacy binary) has no pure-JS reader worth shipping. Ashby accepts the
  // upload, but we cannot score what we cannot read, so say so plainly.
  throw new Error(
    `unsupported resume format "${ext || "unknown"}". Use PDF, DOCX, TXT, MD or RTF.`,
  );
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/\\par[d]?/g, "\n")
    .replace(/\{\\\*?[^{}]*\}/g, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
}

function normalise(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    // Ligatures PDF extraction commonly emits.
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Best-effort identity scrape used to pre-fill the form fields the moment a
 * resume lands, so the user usually has nothing to type. Deliberately
 * conservative: a wrong guess here is worse than an empty box, and the user
 * confirms everything in the UI before Apply unlocks.
 */
export function guessIdentity(text: string): {
  firstName: string;
  lastName: string;
  email: string;
  linkedinUrl: string;
  githubUrl: string;
  phone: string;
} {
  const head = text.slice(0, 2500);

  const email = head.match(/[\w.+-]+@[\w-]+\.[\w.]{2,}/)?.[0] ?? "";

  const linkedin =
    head.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[\w%-]+\/?/i)?.[0] ?? "";

  const github =
    head.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/?/i)?.[0] ?? "";

  const phone =
    head.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] ?? "";

  // A document title ("RESUME", "CURRICULUM VITAE") can sit above the name, so
  // skip past it. A section heading ("SKILLS", "SUMMARY") cannot - the name is
  // always above the first section - so hitting one means we have gone too far
  // and should stop rather than mistake a skills list for a person's name.
  const DOC_TITLE = /^\s*(resume|curriculum\s+vitae|cv)\s*$/i;
  const SECTION =
    /\b(summary|objective|profile|experience|education|skills?|projects?|employment|work\s+history|contact|references|certifications?|awards?|publications?|languages|interests)\b/i;

  let firstName = "";
  let lastName = "";
  for (const raw of head.split("\n").slice(0, 10)) {
    const line = raw.trim();
    if (!line) continue;
    if (DOC_TITLE.test(line)) continue;
    if (SECTION.test(line)) break;
    if (line.length > 60) continue;
    if (/@|https?:|linkedin|github|\d{3}/i.test(line)) continue;

    const words = line.replace(/[|,•·]/g, " ").split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w))) continue;
    firstName = words[0]!;
    lastName = words[words.length - 1]!;
    break;
  }

  return {
    firstName,
    lastName,
    email,
    linkedinUrl: normaliseUrl(linkedin),
    githubUrl: normaliseUrl(github),
    phone,
  };
}

function normaliseUrl(u: string): string {
  if (!u) return "";
  const trimmed = u.replace(/\/$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
