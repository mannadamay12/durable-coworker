import OpenAI from "openai";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI({
    baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  return client;
}

export function modelAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY) && process.env.PLANNER_MODE !== "stub";
}

export async function structuredCall<T>(opts: {
  name: string;
  schema: object;
  system: string;
  user: string;
}): Promise<T> {
  const params = {
    model: process.env.OPENROUTER_MODEL ?? "google/gemini-3.8-flash",
    temperature: 0,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.name, strict: true, schema: opts.schema },
    },
    // OpenRouter-only field, untyped in the SDK. Without it a request can route to an
    // endpoint that treats the schema as a hint.
    provider: { require_parameters: true },
  };

  // Strict enforcement is per-endpoint on OpenRouter, so one retry on unparseable output.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await getClient().chat.completions.create(params as any);
    const content = res.choices[0]?.message?.content ?? "";
    try {
      return JSON.parse(content) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${opts.name}: model returned non-JSON twice (${String(lastError)})`);
}
