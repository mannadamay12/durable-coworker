// The mirror check. One assertion script, no framework.
//   node --env-file=.env --import tsx src/mirror/mirror.check.ts
// Runs against the real Ambiguous workspace when AMBIGUOUS_API_KEY is set, and deletes
// the doc it created at the end.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated state: must be set before core is imported, STATE_DIR is read at load.
const stateDir = mkdtempSync(join(tmpdir(), "coworker-mirror-"));
process.env.STATE_DIR = stateDir;
process.env.STUB_DELAY_MS = "50";

const core = await import("../core/index.js");
const { mirror } = await import("./index.js");
const { ambiguousConfigured, callTool } = await import("./ambiguous.js");

const pass = (msg: string) => console.log(`pass  ${msg}`);
const WO = "WO-MIRROR";
const SEND = "5-send-customer-update";
const APPROVER = "U_APPROVER";
const mdPath = join(stateDir, "workorder.md");
const mapPath = join(stateDir, "mirror-docs.json");
const configured = ambiguousConfigured();

const readMd = () => {
  assert.ok(existsSync(mdPath), `${mdPath} missing`);
  return readFileSync(mdPath, "utf8");
};
const docIdFor = (woId: string): string | undefined => {
  if (!existsSync(mapPath)) return undefined;
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as Record<string, string>;
  return map[woId];
};
// Result shape of get_document is not pinned down, so search the serialised result.
const docText = async (id: string) => JSON.stringify(await callTool("get_document", { id }));

console.log(`ambiguous ${configured ? "configured" : "not configured, file fallback only"}; state ${stateDir}`);

let docId: string | undefined;
try {
  core.reset();
  const created = core.createWorkOrder({ id: WO, scenario: "customer-success", threadRef: "mirror", approvers: [APPROVER] });
  await mirror(created);
  const fresh = readMd();
  assert.ok(fresh.includes(WO));
  assert.ok(fresh.includes("PENDING"));
  pass("fresh work order written to workorder.md with PENDING");

  await core.runReversible(WO);
  await mirror(core.getWorkOrder(WO));
  const waiting = readMd();
  assert.ok(waiting.includes("WAITING ON HUMAN"));
  assert.ok(waiting.includes(SEND));
  pass(`after runReversible workorder.md shows WAITING ON HUMAN at ${SEND}`);

  if (configured) {
    docId = docIdFor(WO);
    assert.ok(docId, "mirror-docs.json has no doc id for WO-MIRROR");
    assert.ok((await docText(docId)).includes("WAITING ON HUMAN"));
    pass(`ambiguous doc ${docId} shows WAITING ON HUMAN`);
  }

  const snapshot = core.getWorkOrder(WO);
  await Promise.all([mirror(snapshot), mirror(snapshot)]);
  assert.equal(docIdFor(WO), docId);
  pass(`two concurrent mirrors keep one doc id (${docId ?? "none, file mode"})`);

  const result = await core.commit(WO, SEND, APPROVER);
  assert.equal(result.status, "committed");
  assert.ok(result.externalId);
  await mirror(core.getWorkOrder(WO));
  const committed = readMd();
  assert.ok(committed.includes("COMMITTED"));
  assert.ok(committed.includes(result.externalId));
  pass(`after commit workorder.md shows COMMITTED and ${result.externalId}`);

  if (configured && docId) {
    assert.equal(docIdFor(WO), docId);
    assert.ok((await docText(docId)).includes(result.externalId));
    pass(`ambiguous doc ${docId} updated in place with ${result.externalId}`);
  }

  // D5: a bad key must not reach the caller, and the file must still be written.
  const savedKey = process.env.AMBIGUOUS_API_KEY;
  const savedMode = process.env.MIRROR_MODE;
  process.env.AMBIGUOUS_API_KEY = "invalid";
  delete process.env.MIRROR_MODE;
  try {
    const modified = { ...core.getWorkOrder(WO), constraints: ["isolation probe"] };
    await assert.doesNotReject(mirror(modified));
    assert.ok(readMd().includes("isolation probe"));
    pass("invalid key: mirror resolved and workorder.md still updated");
  } finally {
    if (savedKey === undefined) delete process.env.AMBIGUOUS_API_KEY;
    else process.env.AMBIGUOUS_API_KEY = savedKey;
    if (savedMode !== undefined) process.env.MIRROR_MODE = savedMode;
  }
} finally {
  if (configured && docId) {
    try {
      await callTool("documents_delete", { id: docId });
      console.log(`cleanup: deleted ambiguous doc ${docId}`);
    } catch (err) {
      console.log(`cleanup: could not delete ambiguous doc ${docId}: ${(err as Error).message}`);
    }
  }
}

console.log("\nall mirror checks passed");
