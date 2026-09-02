import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { CONFIG } from "./config.js";
import { errMsg } from "./util.js";

/**
 * One structured-output call, against whichever provider has a key.
 *
 * Both providers are supported because the choice is the user's, not ours, and
 * the shape we need from either is identical: a JSON object matching a Zod
 * schema. The split is small and lives entirely in this file - nothing
 * downstream knows which model answered.
 *
 * Prompt caching works on both, and the argument split is what makes it work:
 * `instructions` + `cachedSystem` are the stable prefix (the resume, byte
 * identical across a scoring run) and `user` is the volatile part (the job).
 * Anthropic needs an explicit `cache_control` breakpoint; OpenAI caches long
 * stable prefixes automatically. Either way, scoring one resume against 33 jobs
 * pays for the resume once.
 */

export type Provider = "openai" | "anthropic";

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;

/** Which provider to use, decided by which key is present. */
export function activeProvider(): Provider | null {
  if (CONFIG.llm.provider === "openai") return CONFIG.llm.openaiKey ? "openai" : null;
  if (CONFIG.llm.provider === "anthropic") return CONFIG.llm.anthropicKey ? "anthropic" : null;
  // "auto": OpenAI first, since that is what the user configured a key for.
  if (CONFIG.llm.openaiKey) return "openai";
  if (CONFIG.llm.anthropicKey || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return null;
}

/** The model id for the active provider. `AQ_MODEL` overrides the default. */
export function activeModel(): string {
  if (CONFIG.llm.model) return CONFIG.llm.model;
  const p = activeProvider();
  if (p === "anthropic") return CONFIG.llm.defaultAnthropicModel;
  if (p === "openai") return CONFIG.llm.defaultOpenaiModel;
  // No key configured: do not imply a model we are not going to call.
  return "none";
}

export class LlmUnavailable extends Error {
  constructor() {
    super(
      "No LLM credentials found. Put OPENAI_API_KEY (or ANTHROPIC_API_KEY) in .env " +
        "to enable match scoring and answering of unexpected application questions.",
    );
    this.name = "LlmUnavailable";
  }
}

function getOpenai(): OpenAI {
  openai ??= new OpenAI({ apiKey: CONFIG.llm.openaiKey });
  return openai;
}

function getAnthropic(): Anthropic {
  anthropic ??= CONFIG.llm.anthropicKey
    ? new Anthropic({ apiKey: CONFIG.llm.anthropicKey })
    : new Anthropic();
  return anthropic;
}

export interface AskArgs<T extends z.ZodType> {
  schema: T;
  /** Schema name; OpenAI's structured-output format requires one. */
  name: string;
  /** Stable, cacheable: the task rules. */
  instructions: string;
  /** Stable, cacheable: the big context (the resume). */
  cachedSystem: string;
  /** Volatile: the specific question (the job). */
  user: string;
  maxTokens?: number;
  /**
   * How hard the model should think.
   *
   * Matters a lot here: scoring runs the same bounded judgement 80 times, where
   * "low" is several times faster and cheaper with no meaningful quality loss,
   * while a wrong answer written onto a real job application is worth paying
   * "medium" for. Set per call site rather than globally.
   */
  effort?: "minimal" | "low" | "medium" | "high";
}

export async function askStructured<T extends z.ZodType>(
  args: AskArgs<T>,
): Promise<z.infer<T>> {
  const provider = activeProvider();
  if (!provider) throw new LlmUnavailable();
  return provider === "openai" ? askOpenai(args) : askAnthropic(args);
}

async function askOpenai<T extends z.ZodType>(args: AskArgs<T>): Promise<z.infer<T>> {
  const effort = args.effort ?? CONFIG.llm.effort;
  // On gpt-5 the model's reasoning tokens count against max_output_tokens, so
  // the cap must leave real headroom above the small JSON we actually want.
  // Billing is only for tokens generated, so a generous ceiling is free when
  // unused - and a tight one silently truncates, which is what made scoring
  // fall back to the keyword heuristic across a whole board.
  const cap = Math.max(16_000, (args.maxTokens ?? 4096) * 6);

  const call = (eff: NonNullable<AskArgs<T>["effort"]>, maxOut: number) =>
    getOpenai().responses.parse({
      model: activeModel(),
      // `instructions` is the stable prefix OpenAI's automatic caching keys on.
      instructions: `${args.instructions}\n\n${args.cachedSystem}`,
      input: args.user,
      max_output_tokens: maxOut,
      reasoning: { effort: eff },
      text: { format: zodTextFormat(args.schema, args.name) },
    });

  let res = await call(effort, cap);

  // Truncated by the cap: retry once with minimal reasoning and twice the room
  // rather than failing the job (and then quietly scoring it by keyword).
  if (res.status === "incomplete" && res.incomplete_details?.reason === "max_output_tokens") {
    const u0 = res.usage;
    if (u0) recordUsage(u0.input_tokens ?? 0, u0.output_tokens ?? 0, u0.input_tokens_details?.cached_tokens ?? 0);
    res = await call("minimal", cap * 2);
  }

  if (res.status === "incomplete") {
    throw new Error(
      `model stopped early (${res.incomplete_details?.reason ?? "unknown"}) even after a retry`,
    );
  }
  const u = res.usage;
  if (u) recordUsage(u.input_tokens ?? 0, u.output_tokens ?? 0, u.input_tokens_details?.cached_tokens ?? 0);

  const parsed = res.output_parsed;
  if (parsed == null) {
    const refusal = findRefusal(res.output);
    throw new Error(
      refusal ? `model declined: ${refusal}` : "model returned no parseable output",
    );
  }
  return parsed as z.infer<T>;
}

/** Dig a refusal message out of the Responses output blocks, if there is one. */
function findRefusal(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; refusal?: string };
      if (b.type === "refusal" && typeof b.refusal === "string") return b.refusal;
    }
  }
  return null;
}

async function askAnthropic<T extends z.ZodType>(args: AskArgs<T>): Promise<z.infer<T>> {
  const res = await getAnthropic().messages.parse({
    model: activeModel(),
    max_tokens: args.maxTokens ?? 4096,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(args.schema) },
    system: [
      { type: "text", text: args.instructions },
      // Explicit breakpoint: everything above this is served from cache.
      { type: "text", text: args.cachedSystem, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: args.user }],
  });

  const u = res.usage;
  if (u) {
    recordUsage(
      u.input_tokens ?? 0,
      u.output_tokens ?? 0,
      (u.cache_read_input_tokens ?? 0),
    );
  }

  if (res.stop_reason === "refusal") {
    throw new Error(`model declined (${res.stop_details?.category ?? "unspecified"})`);
  }
  if (!res.parsed_output) throw new Error("model returned no parseable output");
  return res.parsed_output as z.infer<T>;
}

/* ---------------------------------------------------------------- *
 * Readiness
 * ---------------------------------------------------------------- */

/* ---------------------------------------------------------------- *
 * Token usage accounting
 * ---------------------------------------------------------------- */

interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from cache (billed cheaper). Best-effort. */
  cachedInputTokens: number;
}

const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

function recordUsage(input: number, output: number, cached = 0): void {
  usage.calls += 1;
  usage.inputTokens += input || 0;
  usage.outputTokens += output || 0;
  usage.cachedInputTokens += cached || 0;
}

/**
 * Estimated spend so far.
 *
 * Token counts are exact (straight from each API response); the dollar figure
 * is an estimate from per-million rates, since prices change and cached input is
 * discounted. Override the rates with AQ_PRICE_IN / AQ_PRICE_OUT (USD per 1M).
 */
export function usageStats(): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  priced: boolean;
} {
  const inRate = CONFIG.llm.priceInPerM;
  const outRate = CONFIG.llm.priceOutPerM;
  const billedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (billedInput / 1e6) * inRate +
    (usage.cachedInputTokens / 1e6) * inRate * 0.25 + // cached input ~1/4 price
    (usage.outputTokens / 1e6) * outRate;
  return {
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    estCostUsd: Math.round(cost * 10000) / 10000,
    priced: inRate > 0 || outRate > 0,
  };
}

let probe: { ok: boolean; detail: string } | null = null;

/**
 * Confirm we can actually reach the configured model, once per process.
 *
 * Checked against the provider's model list rather than assumed, because a
 * wrong `AQ_MODEL` would otherwise surface as 33 identical failures halfway
 * through a scoring run. On a miss we name some models the key can actually
 * see, which is the fastest path to a working config.
 */
export async function llmReady(): Promise<boolean> {
  return (await llmStatus()).ok;
}

export async function llmStatus(): Promise<{
  ok: boolean;
  provider: Provider | null;
  model: string;
  detail: string;
}> {
  const provider = activeProvider();
  const model = activeModel();

  if (!provider) {
    return { ok: false, provider: null, model, detail: "no API key configured" };
  }
  if (probe) return { ...probe, provider, model };

  try {
    if (provider === "openai") await getOpenai().models.retrieve(model);
    else await getAnthropic().models.retrieve(model);
    probe = { ok: true, detail: "ok" };
  } catch (err) {
    let detail = errMsg(err);
    try {
      const ids =
        provider === "openai"
          ? (await getOpenai().models.list()).data.map((m) => m.id)
          : (await getAnthropic().models.list()).data.map((m) => m.id);
      const hint = ids
        .filter((id) => /^(gpt|o\d|claude)/.test(id))
        .slice(0, 8)
        .join(", ");
      if (hint) detail += ` | models this key can use: ${hint} (set AQ_MODEL)`;
    } catch {
      /* listing is best-effort - the original error is what matters */
    }
    probe = { ok: false, detail };
    console.warn(`[llm] ${provider}/${model} unavailable: ${detail}`);
  }
  return { ...probe, provider, model };
}
