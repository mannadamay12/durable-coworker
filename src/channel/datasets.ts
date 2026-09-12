import { datasetUsers, findThread } from "../core/context.js";

export type MentionSelection = { kind: "dataset"; id: string } | { kind: "fixture"; id: string };
export class SourceSelectionError extends Error {}

export const SELECTION_HELP = "Start with `@Angie take this THREAD-ACME-OUTAGE` or `@Angie use fixture customer-success`. Dataset IDs select a supplied demo seed; I cannot read Slack thread history from this mention.";

/** Only explicit commands can select source material. Message length is not context. */
export function mentionSelection(text: string): MentionSelection | undefined {
  const command = text.trim().replace(/^(?:(?:<@[A-Z0-9]+(?:\|[^>]+)?>|@[\w.-]+)\s*)+/i, "");
  const dataset = /^take\s+this\s+(THREAD-[A-Z0-9-]+)[.!]?$/i.exec(command);
  if (dataset) return { kind: "dataset", id: dataset[1].toUpperCase() };
  const fixture = /^use\s+fixture\s+([a-z0-9-]+)[.!]?$/i.exec(command);
  if (fixture) return { kind: "fixture", id: fixture[1].toLowerCase() };
  if (/\bTHREAD-|\buse\s+fixture\b/i.test(command)) {
    throw new SourceSelectionError(`Use one explicit source selection per mention. ${SELECTION_HELP}`);
  }
  return undefined;
}

/** The trusted deployment configuration maps seed identities to platform identities. */
export function datasetSlackApprovers(threadId: string, raw = process.env.DATASET_SLACK_USERS): string[] {
  const thread = findThread(threadId);
  if (!thread) throw new SourceSelectionError(`Unknown dataset thread ${threadId}. ${SELECTION_HELP}`);
  if (!thread.customerId || !thread.approvers.length || !thread.constraints.length) {
    throw new SourceSelectionError(`${threadId} needs a customer, a constraint, and an allowlisted approver.`);
  }
  if (!raw) throw new SourceSelectionError("Dataset Slack identities are not configured. Set DATASET_SLACK_USERS to a JSON object mapping the seed's approvers to real Slack user IDs, then retry this mention.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SourceSelectionError("DATASET_SLACK_USERS must be a JSON object mapping dataset user IDs to real Slack user IDs."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SourceSelectionError("DATASET_SLACK_USERS must be a JSON object.");
  }
  const mapping = value as Record<string, unknown>;
  // JSON.parse accepts duplicate keys; reject those rather than letting the last
  // spelling silently choose who can approve. Mapping values must all be strings.
  const keys = [...raw.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(match => JSON.parse(`"${match[1]}"`) as string);
  if (keys.length !== new Set(keys).size) throw new SourceSelectionError("DATASET_SLACK_USERS has duplicate keys; every dataset user needs one unambiguous mapping.");
  const users = new Map(datasetUsers().map(user => [user.slackUserId, user]));
  for (const [synthetic, real] of Object.entries(mapping)) {
    const user = users.get(synthetic);
    if (!user) throw new SourceSelectionError(`DATASET_SLACK_USERS contains unknown dataset user ${synthetic}.`);
    if (user.isAgent || synthetic === "U_SAM") throw new SourceSelectionError(`${synthetic} cannot be mapped as a Slack approver persona.`);
    if (typeof real !== "string" || !/^[UW][A-Z0-9]{8,}$/.test(real)) {
      throw new SourceSelectionError(`DATASET_SLACK_USERS must map ${synthetic} to a real Slack user ID, not a synthetic ID or display name.`);
    }
  }
  const approvers = thread.approvers.map(id => {
    const user = users.get(id);
    if (!user || user.isAgent || id === "U_SAM") throw new SourceSelectionError(`${id} is not an eligible dataset approver.`);
    const real = mapping[id];
    if (typeof real !== "string") throw new SourceSelectionError(`DATASET_SLACK_USERS is missing an approver mapping for ${id}.`);
    return real;
  });
  if (new Set(approvers).size !== approvers.length) {
    throw new SourceSelectionError(`DATASET_SLACK_USERS maps different approvers on ${threadId} to the same Slack user. Each approver on this thread needs a distinct identity.`);
  }
  return approvers;
}
