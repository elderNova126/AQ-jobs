import { z } from "zod";
import { askStructured } from "../llm.js";
import type { ResumeProfile } from "../types.js";
import { truncate } from "../util.js";

const ProfileSchema = z.object({
  headline: z.string().describe("One line: role + focus, e.g. 'Full-stack engineer, 6y, React/Node/AWS'"),
  yearsExperience: z
    .number()
    .nullable()
    .describe("Total professional years; null if genuinely unclear"),
  seniority: z
    .string()
    .describe("One of: intern, junior, mid, senior, staff, principal, lead, manager, director, executive"),
  skills: z.array(z.string()).describe("Concrete technologies, languages, tools. 10-40 items."),
  domains: z
    .array(z.string())
    .describe("Problem domains, e.g. 'ML infrastructure', 'fintech', 'healthcare', 'devtools'"),
  education: z.array(z.string()).describe("'Degree, Field, Institution' per entry"),
  companies: z.array(z.string()).describe("Employers, most recent first"),
  highlights: z
    .array(z.string())
    .describe("3-6 strongest, most quantified accomplishments, verbatim-ish"),
  workAuthorization: z.object({
    usAuthorized: z
      .boolean()
      .nullable()
      .describe("Authorized to work in the US without sponsorship? null if the resume does not say"),
    needsSponsorship: z
      .boolean()
      .nullable()
      .describe("Will they need visa sponsorship? null if the resume does not say"),
    evidence: z
      .string()
      .describe("Quote or cite what implies this, or 'not stated in resume'"),
  }),
});

const INSTRUCTIONS = `You extract a structured profile from a resume.

Rules:
- Report only what the resume supports. Never invent employers, degrees, or skills.
- For workAuthorization, use null unless the resume states or plainly implies it
  (e.g. "US Citizen", "Green Card", "requires H-1B sponsorship", "authorized to
  work in the US"). A US address or a US university alone is NOT evidence of work
  authorization - use null.
- seniority should reflect scope and years, not just job titles.`;

/**
 * Build the reusable profile once per resume.
 *
 * Worth doing eagerly at upload time: it makes the 33 scoring calls smaller and
 * more consistent, and it gives the answering step a compact, structured view of
 * the candidate for questions like work authorization.
 */
export async function extractProfile(resumeText: string): Promise<ResumeProfile> {
  const parsed = await askStructured({
    schema: ProfileSchema,
    name: "resume_profile",
    instructions: INSTRUCTIONS,
    cachedSystem: `RESUME\n=====\n${truncate(resumeText, 60_000)}`,
    user: "Extract the structured profile for this resume.",
    maxTokens: 4096,
    effort: "medium",
  });

  return {
    headline: parsed.headline,
    yearsExperience: parsed.yearsExperience,
    seniority: parsed.seniority,
    skills: parsed.skills,
    domains: parsed.domains,
    education: parsed.education,
    companies: parsed.companies,
    highlights: parsed.highlights,
    workAuthorization: parsed.workAuthorization,
  };
}
