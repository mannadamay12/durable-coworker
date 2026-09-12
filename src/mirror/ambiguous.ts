// Thin Ambiguous MCP client over plain fetch. The endpoint is stateless, so every
// tools/call is a standalone POST with no initialize handshake.

const ENDPOINT = "https://app.ambiguous.ai/mcp";

let nextId = 1;

export function ambiguousConfigured(): boolean {
  return Boolean(process.env.AMBIGUOUS_API_KEY) && process.env.MIRROR_MODE !== "file";
}

class ToolError extends Error {
  constructor(
    message: string,
    readonly toolError: boolean,
  ) {
    super(message);
  }
}

interface RpcResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

// Streamable HTTP may answer with SSE or plain JSON; take the first data line that parses.
function parseBody(body: string, contentType: string | null): RpcResponse {
  if (contentType?.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5).trim()) as RpcResponse;
      } catch {
        continue;
      }
    }
    throw new Error("ambiguous: no JSON-RPC message in event stream");
  }
  return JSON.parse(body) as RpcResponse;
}

export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<T> {
  const key = process.env.AMBIGUOUS_API_KEY;
  if (!key) throw new Error("ambiguous: AMBIGUOUS_API_KEY not set");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`ambiguous: ${name} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const msg = parseBody(body, res.headers.get("content-type"));
  if (msg.error) {
    throw new ToolError(`ambiguous: ${name} rpc error ${msg.error.code}: ${msg.error.message}`, false);
  }
  const result = msg.result;
  if (!result) throw new Error(`ambiguous: ${name} returned no result`);

  const text = result.content?.find((c) => c.type === "text")?.text;
  if (result.isError) {
    throw new ToolError(`ambiguous: ${name} failed: ${text ?? "unknown error"}`, true);
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  if (text === undefined) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

interface DocRecord {
  id?: string;
  trashed_at?: string | null;
  document?: { id?: string };
}

async function createDoc(title: string, markdown: string): Promise<string> {
  const doc = await callTool<DocRecord>("create_document", {
    type: "doc",
    title,
    content: markdown,
  });
  const id = doc?.id ?? doc?.document?.id;
  if (!id) throw new Error("ambiguous: create_document returned no id");
  return id;
}

// Ambiguous reports a missing doc only as a generic tool error, so confirm with
// get_document. A soft-deleted doc counts as gone: updating it would be invisible.
async function docIsGone(docId: string): Promise<boolean> {
  try {
    const doc = await callTool<DocRecord>("get_document", { id: docId });
    return Boolean(doc?.trashed_at);
  } catch (err) {
    return err instanceof ToolError;
  }
}

export async function upsertDoc(
  docId: string | undefined,
  title: string,
  markdown: string,
): Promise<string> {
  if (!docId) return createDoc(title, markdown);
  try {
    await callTool("update_document", { id: docId, title, content: markdown });
    return docId;
  } catch (err) {
    if (err instanceof ToolError && (await docIsGone(docId))) {
      return createDoc(title, markdown);
    }
    throw err;
  }
}
