import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type Provider = "openai" | "anthropic" | "gemini";

type ProviderConfig = {
  defaultModel: string;
  envKey: string;
};

const PROVIDERS: Record<Provider, ProviderConfig> = {
  openai: { defaultModel: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  anthropic: { defaultModel: "claude-haiku-4-5-20251001", envKey: "ANTHROPIC_API_KEY" },
  gemini: { defaultModel: "gemini-2.0-flash", envKey: "GEMINI_API_KEY" },
};

type Attempt = {
  provider: Provider;
  model: string;
  ok: boolean;
  error?: string;
  status?: number;
  durationMs: number;
};

type CompleteResult = {
  text: string;
  provider_used: Provider;
  model_used: string;
  attempts: Attempt[];
};

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callOpenAI(prompt: string, model: string, key: string, temperature: number, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(prompt: string, model: string, key: string, temperature: number, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const j = (await res.json()) as { content: { type: string; text?: string }[] };
  return j.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") ?? "";
}

async function callGemini(prompt: string, model: string, key: string, temperature: number, maxTokens: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

async function callProvider(provider: Provider, prompt: string, model: string, key: string, temperature: number, maxTokens: number): Promise<string> {
  if (provider === "openai") return callOpenAI(prompt, model, key, temperature, maxTokens);
  if (provider === "anthropic") return callAnthropic(prompt, model, key, temperature, maxTokens);
  if (provider === "gemini") return callGemini(prompt, model, key, temperature, maxTokens);
  throw new Error(`Unknown provider: ${provider}`);
}

const isRetryable = (e: unknown): boolean => {
  const err = e as { status?: number; message?: string };
  if (err.status === 429) return true;
  if (typeof err.status === "number" && err.status >= 500) return true;
  if (err.message && /timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(err.message)) return true;
  return false;
};

function attemptFromError(provider: Provider, model: string, started: number, e: unknown): Attempt {
  const err = e as { message?: string; status?: number };
  return { provider, model, ok: false, error: err.message ?? String(e), status: err.status, durationMs: Date.now() - started };
}

async function tryWithRetry(provider: Provider, prompt: string, model: string, key: string, temperature: number, maxTokens: number): Promise<{ text: string; attempt: Attempt }> {
  const started = Date.now();
  try {
    const text = await callProvider(provider, prompt, model, key, temperature, maxTokens);
    return { text, attempt: { provider, model, ok: true, durationMs: Date.now() - started } };
  } catch (e) {
    if (!isRetryable(e)) throw attemptFromError(provider, model, started, e);
    await sleep(1000 + Math.random() * 800);
    const retryStart = Date.now();
    try {
      const text = await callProvider(provider, prompt, model, key, temperature, maxTokens);
      return { text, attempt: { provider, model, ok: true, durationMs: Date.now() - retryStart } };
    } catch (e2) {
      throw attemptFromError(provider, model, retryStart, e2);
    }
  }
}

const DEFAULT_CHAIN: Provider[] = ["openai", "anthropic", "gemini"];

async function completeWithFallback(opts: {
  prompt: string;
  chain?: Provider[];
  model_overrides?: Partial<Record<Provider, string>>;
  temperature?: number;
  max_tokens?: number;
}): Promise<CompleteResult> {
  const chain = opts.chain && opts.chain.length > 0 ? opts.chain : DEFAULT_CHAIN;
  const temperature = opts.temperature ?? 0.5;
  const maxTokens = opts.max_tokens ?? 1024;
  const attempts: Attempt[] = [];

  for (const provider of chain) {
    const cfg = PROVIDERS[provider];
    const key = process.env[cfg.envKey];
    const model = opts.model_overrides?.[provider] ?? cfg.defaultModel;

    if (!key) {
      attempts.push({ provider, model, ok: false, error: `${cfg.envKey} not set`, durationMs: 0 });
      continue;
    }

    try {
      const { text, attempt } = await tryWithRetry(provider, opts.prompt, model, key, temperature, maxTokens);
      attempts.push(attempt);
      return { text, provider_used: provider, model_used: model, attempts };
    } catch (failedAttempt) {
      attempts.push(failedAttempt as Attempt);
      continue;
    }
  }

  const reason = attempts.map((a) => `${a.provider}: ${a.ok ? "ok" : a.error}`).join(" | ");
  throw new Error(`All providers in chain failed. ${reason}`);
}

function healthCheck(): { provider: Provider; configured: boolean; envKey: string; defaultModel: string }[] {
  return (Object.keys(PROVIDERS) as Provider[]).map((p) => ({
    provider: p,
    configured: !!process.env[PROVIDERS[p].envKey],
    envKey: PROVIDERS[p].envKey,
    defaultModel: PROVIDERS[p].defaultModel,
  }));
}

const server = new Server({ name: "llm-fallback-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

const COMPLETE_TOOL = {
  name: "complete",
  description: "Complete a prompt with automatic provider fallback. Tries OpenAI -> Anthropic Claude -> Google Gemini in order. Each provider gets one retry on rate limit / 5xx / network errors with backoff. Returns the response, the provider that succeeded, and a full per-provider attempt log. Requires at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in the environment.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The user prompt to send." },
      chain: { type: "array", items: { type: "string", enum: ["openai", "anthropic", "gemini"] }, description: "Optional provider order. Defaults to ['openai', 'anthropic', 'gemini']." },
      model_overrides: { type: "object", properties: { openai: { type: "string" }, anthropic: { type: "string" }, gemini: { type: "string" } }, description: "Optional per-provider model id override. Defaults: openai=gpt-4o-mini, anthropic=claude-haiku-4-5-20251001, gemini=gemini-2.0-flash." },
      temperature: { type: "number", description: "Sampling temperature 0-2. Default 0.5." },
      max_tokens: { type: "number", description: "Max output tokens. Default 1024." },
    },
    required: ["prompt"],
  },
} as const;

const HEALTH_TOOL = {
  name: "health_check",
  description: "Return which providers are configured (have their API keys set in the environment) and their default models. Use this to confirm setup before calling 'complete'.",
  inputSchema: { type: "object", properties: {} },
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [COMPLETE_TOOL, HEALTH_TOOL] }));

const CompleteArgsSchema = z.object({
  prompt: z.string().min(1),
  chain: z.array(z.enum(["openai", "anthropic", "gemini"])).optional(),
  model_overrides: z.object({
    openai: z.string().optional(),
    anthropic: z.string().optional(),
    gemini: z.string().optional(),
  }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "complete") {
    const parsed = CompleteArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Error: invalid args: ${parsed.error.message}` }], isError: true };
    }
    try {
      const result = await completeWithFallback(parsed.data);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }

  if (name === "health_check") {
    return { content: [{ type: "text", text: JSON.stringify(healthCheck(), null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[llm-fallback-mcp] running on stdio");
