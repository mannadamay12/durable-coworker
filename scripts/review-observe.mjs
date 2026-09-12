// Local read-only observer. Explicit path prevents accidental use of another worktree's .env.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { snapshot } from "./review-snapshot.mjs";

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const stateArg = value("--state-dir");
if (!stateArg || stateArg.startsWith("--")) throw new Error("Usage: node scripts/review-observe.mjs --state-dir /absolute/state/path [--port 4318]");
const stateDir = resolve(stateArg);
const port = Number(value("--port") ?? 4318);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const page = readFileSync(new URL("./review-dashboard.html", import.meta.url));
const server = createServer((req, res) => {
  // No CORS; reject foreign Host headers as well as mutations.
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) { res.writeHead(403); res.end(); return; }
  if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return; }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page); return; }
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/snapshot") { res.end(JSON.stringify(snapshot(stateDir))); return; }
    if (path === "/api/replay") {
      const file = resolve(stateDir, "review-replay.json");
      res.end(existsSync(file) ? readFileSync(file) : "null"); return;
    }
    if (path === "/api/model-probes") {
      const file = new URL("../notes/review-planner-live-results.json", import.meta.url);
      if (!existsSync(file)) { res.end("null"); return; }
      const report = JSON.parse(readFileSync(file, "utf8"));
      res.end(JSON.stringify({ generatedAt: report.generatedAt, revision: report.revision,
        requests: report.cases.flatMap(c => c.requests.map(r => ({ caseId: c.id, purpose: r.schema,
          model: r.model, provider: r.provider, status: r.httpStatus, durationMs: r.durationMs,
          generationId: r.generationId, tokens: r.usage?.total_tokens, cost: r.usage?.cost }))) })); return;
    }
    res.writeHead(404); res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) { res.writeHead(503); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(port, "127.0.0.1", () => console.log(`Evidence viewer: http://127.0.0.1:${server.address().port}\nReading: ${stateDir}\nRead-only; no model calls, approvals, or sends.`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
