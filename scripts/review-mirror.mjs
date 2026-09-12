// Offline characterization. No .env is loaded and all provider traffic is mocked.
// node scripts/review-mirror.mjs [--strict]
import { register } from "tsx/esm/api";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
register();
const root = resolve(new URL("..", import.meta.url).pathname);
const child = process.argv.includes("--child");
const state = child ? process.env.REVIEW_STATE : mkdtempSync(resolve(tmpdir(), "durable-review-mirror-"));
process.env.STATE_DIR = state;
process.env.AMBIGUOUS_API_KEY = "review-mock-key";
process.env.AMBIGUOUS_MCP_URL = "http://127.0.0.1:1/intended-test-endpoint";
delete process.env.MIRROR_MODE;
const workOrder = (id = "WO-REVIEW-MIRROR") => ({ id, scenario: "review", threadRef: id,
  constraints: ["Do not offer a refund"], approvers: ["U_REVIEW"],
  steps: [{ id: "1-draft", name: "Draft response", kind: "reversible", tool: "draft", status: "done", classifiedBy: "model", output: "UNIQUE_DRAFT_EVIDENCE" },
    { id: "2-send", name: "Send response", kind: "commit", tool: "mail.send", status: "waiting_human", classifiedBy: "allowlist_override" }],
  commits: [{ idempotencyKey: `${id}:2-send:mail.send:hash`, tool: "mail.send", args: { to: "review@example.invalid", subject: "Unique review proposal", body: "UNIQUE_APPROVED_PAYLOAD" }, status: "proposed" }],
});
const originalFetch = globalThis.fetch;
let behavior = "normal";
const calls = [];
globalThis.fetch = async (input, init) => {
  const request = JSON.parse(init.body);
  calls.push({ endpoint: String(input), name: request.params.name, args: request.params.arguments });
  if (child) {
    const mockUrl = new URL(process.env.REVIEW_MOCK_URL);
    if (mockUrl.hostname !== "127.0.0.1") throw new Error("mock transport must be loopback");
    return originalFetch(mockUrl, { ...init, signal: AbortSignal.timeout(5_000) });
  }
  if (behavior === "transient" && request.params.name !== "create_document") {
    return Response.json({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "temporary backend outage; existing document still present" }] } });
  }
  const response = { jsonrpc: "2.0", id: behavior === "wrong-id" ? request.id + 100 : request.id, result: { structuredContent: { id: "mock-doc" } } };
  if (behavior === "notification-first") {
    return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\ndata: ${JSON.stringify(response)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json(response);
};
const { upsertDoc, callTool } = await import("../src/mirror/ambiguous.ts");
const { mirror, renderWorkOrder } = await import("../src/mirror/index.ts");
if (child) {
  await mirror(workOrder("WO-MULTIPROCESS"));
  process.exit(0);
}
const report = { checkedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), mode: "offline-mocked-transport", checks: [], notes: ["No real provider calls, credentials, external documents or main state used.", "Desired-behavior checks report known findings; --strict fails if findings remain."] };
const check = (name, passed, evidence) => report.checks.push({ name, status: passed ? "pass" : "fail", evidence });
let server;
try {
  const rendered = renderWorkOrder(workOrder());
  check("mirror renders durable draft evidence", rendered.includes("UNIQUE_DRAFT_EVIDENCE"), { draftPresent: rendered.includes("UNIQUE_DRAFT_EVIDENCE") });
  check("mirror renders exact proposed recipient, subject and status", rendered.includes("review@example.invalid") && rendered.includes("Unique review proposal") && rendered.includes("(PROPOSED)"), { proposedArgsPresent: rendered.includes("review@example.invalid") && rendered.includes("Unique review proposal") && rendered.includes("(PROPOSED)") });

  const start = calls.length;
  await Promise.all([mirror(workOrder()), mirror(workOrder())]);
  check("same-process mirrors coalesce initial creation", calls.slice(start).filter(call => call.name === "create_document").length === 1, calls.slice(start));
  check("configured MCP endpoint is honored", calls[start].endpoint === process.env.AMBIGUOUS_MCP_URL, { configured: process.env.AMBIGUOUS_MCP_URL, actual: calls[start].endpoint });

  behavior = "transient";
  const transientStart = calls.length;
  await upsertDoc("existing-doc", "Existing document", "new body");
  const transientCalls = calls.slice(transientStart);
  check("transient tool errors do not imply deleted document", !transientCalls.some(call => call.name === "create_document"), transientCalls.map(call => call.name));

  behavior = "wrong-id";
  let rejectedWrongId = false;
  try { await callTool("get_document", { id: "existing-doc" }); } catch { rejectedWrongId = true; }
  check("RPC response ID must match request", rejectedWrongId, { rejectedWrongId });
  behavior = "notification-first";
  let parsedResponse = false;
  try { parsedResponse = (await callTool("get_document", { id: "existing-doc" }))?.id === "mock-doc"; } catch { /* captured below */ }
  check("SSE notification before response is supported", parsedResponse, { parsedResponse });

  process.env.MIRROR_MODE = "file";
  await mirror(workOrder("WO-FILE-A"));
  await mirror(workOrder("WO-FILE-B"));
  const file = readFileSync(resolve(state, "workorder.md"), "utf8");
  check("file mirror retains both work orders", file.includes("WO-FILE-A") && file.includes("WO-FILE-B"), { containsA: file.includes("WO-FILE-A"), containsB: file.includes("WO-FILE-B"), note: "Current fixed camera file intentionally keeps only the last work order; this limits multi-customer demo use." });

  const waiting = [];
  let createCount = 0;
  server = createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const message = JSON.parse(Buffer.concat(parts).toString());
    if (message.params.name === "create_document") {
      createCount++;
      const createdId = `mock-doc-${createCount}`;
      waiting.push(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { id: createdId } } })); });
      if (waiting.length === 2) waiting.forEach((respond, i) => setTimeout(respond, i * 20));
    } else {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { id: "mock-existing" } } }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const runChild = () => new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, [resolvePath("scripts/review-mirror.mjs"), "--child"], {
      cwd: root, env: { PATH: process.env.PATH, REVIEW_STATE: state, REVIEW_MOCK_URL: `http://127.0.0.1:${server.address().port}` }, stdio: "ignore",
    });
    processHandle.on("error", reject);
    processHandle.on("exit", code => code === 0 ? resolve() : reject(new Error(`mock child exited ${code}`)));
  });
  await Promise.all([runChild(), runChild()]);
  check("separate processes create one document for one work order", createCount === 1, { providerCreateCalls: createCount, mapping: JSON.parse(readFileSync(resolve(state, "mirror-docs.json"), "utf8"))["WO-MULTIPROCESS"] });
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  report.summary = { total: report.checks.length, passed: report.checks.filter(check => check.status === "pass").length, failed: report.checks.filter(check => check.status === "fail").length };
  writeFileSync(resolve(root, "notes/review-mirror-results.json"), JSON.stringify(report, null, 2) + "\n");
  rmSync(state, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  console.log(JSON.stringify(report.summary));
  if (process.argv.includes("--strict") && report.summary.failed) process.exitCode = 1;
}
function resolvePath(relative) { return resolve(root, relative); }
