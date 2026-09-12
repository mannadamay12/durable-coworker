// Customer context from the imported datasets/ pack. A work order whose `scenario` is a
// dataset thread id is grounded in that thread. Missing dataset threads must never
// fall through to the legacy customer-success fixture.
import threadsJson from "../../datasets/threads.json" with { type: "json" };
import customersJson from "../../datasets/customers.json" with { type: "json" };
import researchJson from "../../datasets/research_blobs.json" with { type: "json" };
import tasksJson from "../../datasets/tasks_seed.json" with { type: "json" };
import fixturesJson from "../../datasets/work_order_fixtures.json" with { type: "json" };
import usersJson from "../../datasets/users.json" with { type: "json" };

import type { Step } from "./contract.js";

export interface Contact {
  name: string;
  title: string;
  email: string;
}
export interface Customer {
  id: string;
  name: string;
  tier: string;
  domain: string;
  contacts: Contact[];
  doNot: string[];
}
export interface Thread {
  id: string;
  channel: string;
  ts: string;
  useCase: string;
  customerId: string | null;
  approvers: string[];
  commitTool: string | null;
  commitTarget: string | null;
  constraints: string[];
  messages: { user: string; ts: string; text: string }[];
}
export interface Research {
  id: string;
  threadId: string;
  citations: { title: string; url: string; highlight: string }[];
  draftEmail?: { to: string; subject: string; body: string };
  draftStatus?: { visibility: string; state: string; body: string };
}
export interface TaskTemplate {
  title: string;
  assignee: string;
  customerId: string;
}
export interface RecoveryFixture {
  id: string;
  threadId: string;
  fixtureFor: string;
  approvers: string[];
}
export interface Context {
  thread: Thread;
  customer: Customer;
  research?: Research;
  tasks: TaskTemplate[];
}

export interface DatasetUser {
  slackUserId: string;
  name: string;
  role: string;
  isApproverDefault: boolean;
  isAgent?: boolean;
}
export interface DatasetPack {
  threads: Thread[];
  customers: Customer[];
  blobs: Research[];
  tasks: Record<string, TaskTemplate[]>;
  fixtures: RecoveryFixture[];
  users: DatasetUser[];
}

const invalid = (path: string, reason: string): never => { throw new Error(`invalid dataset ${path}: ${reason}`); };
function record(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "expected object");
}
function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid(path, "expected nonempty string");
}
function list(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid(path, "expected array");
}
function strings(value: unknown, path: string): asserts value is string[] {
  list(value, path);
  value.forEach((v, i) => string(v, `${path}[${i}]`));
}
function fields(value: Record<string, unknown>, names: string[], path: string): void {
  for (const name of names) string(value[name], `${path}.${name}`);
}
function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) invalid(path, "duplicate IDs or values");
}
function safeId(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}-[A-Za-z0-9_-]+$`).test(value)) invalid(value, `expected safe ${prefix}- ID without separators`);
}

/** Validate only fields consumed by the runtime. Historical ledger rows are never loaded. */
export function validateDatasetPack(input: unknown): DatasetPack {
  record(input, "pack");
  for (const key of ["threads", "customers", "blobs", "fixtures", "users"]) {
    list(input[key], key);
    (input[key] as unknown[]).forEach((v, i) => record(v, `${key}[${i}]`));
  }
  record(input.tasks, "tasks");
  const pack = input as unknown as DatasetPack;
  for (const user of pack.users) {
    fields(user as unknown as Record<string, unknown>, ["slackUserId", "name", "role"], "user");
    if (typeof user.isApproverDefault !== "boolean") invalid(user.slackUserId, "isApproverDefault must be boolean");
    if (user.isAgent !== undefined && typeof user.isAgent !== "boolean") invalid(user.slackUserId, "isAgent must be boolean");
  }
  unique(pack.users.map((u) => u.slackUserId), "users");
  const users = new Map(pack.users.map((u) => [u.slackUserId, u]));
  const knownUser = (id: string, path: string) => {
    if (!users.has(id)) invalid(path, `unknown user ${id}`);
  };
  const approvers = (ids: unknown, path: string) => {
    strings(ids, path);
    unique(ids, path);
    for (const id of ids) {
      knownUser(id, path);
      if (id === "U_SAM" || users.get(id)?.isAgent) invalid(path, `${id} cannot approve`);
    }
  };
  for (const customer of pack.customers) {
    fields(customer as unknown as Record<string, unknown>, ["id", "name", "tier", "domain"], "customer");
    strings(customer.doNot, `${customer.id}.doNot`);
    list(customer.contacts, `${customer.id}.contacts`);
    for (const contact of customer.contacts) {
      record(contact, `${customer.id}.contact`);
      fields(contact, ["name", "title", "email"], `${customer.id}.contact`);
    }
    unique(customer.contacts.map((c) => c.email), `${customer.id}.contacts`);
  }
  unique(pack.customers.map((c) => c.id), "customers");
  const customers = new Map(pack.customers.map((c) => [c.id, c]));
  for (const thread of pack.threads) {
    fields(thread as unknown as Record<string, unknown>, ["id", "channel", "ts", "useCase"], "thread");
    safeId(thread.id, "THREAD");
    approvers(thread.approvers, `${thread.id}.approvers`);
    strings(thread.constraints, `${thread.id}.constraints`);
    list(thread.messages, `${thread.id}.messages`);
    for (const message of thread.messages) {
      record(message, `${thread.id}.message`);
      fields(message, ["user", "ts", "text"], `${thread.id}.message`);
      knownUser(message.user, `${thread.id}.message.user`);
    }
    if (thread.customerId === null) {
      if (thread.commitTool !== null || thread.commitTarget !== null || thread.approvers.length) {
        invalid(thread.id, "a thread without a customer cannot configure an outbound action");
      }
    } else {
      string(thread.customerId, `${thread.id}.customerId`);
      if (!customers.has(thread.customerId)) invalid(thread.id, `unknown customer ${thread.customerId}`);
      string(thread.commitTool, `${thread.id}.commitTool`);
      string(thread.commitTarget, `${thread.id}.commitTarget`);
      if (!thread.approvers.length) invalid(thread.id, "no allowlisted approver");
      if (thread.commitTool === "mail.send" && !customers.get(thread.customerId)!.contacts.some((c) => c.email === thread.commitTarget)) {
        invalid(thread.id, `recipient ${thread.commitTarget} is not a customer contact`);
      }
    }
  }
  unique(pack.threads.map((t) => t.id), "threads");
  const threads = new Map(pack.threads.map((t) => [t.id, t]));
  for (const blob of pack.blobs) {
    fields(blob as unknown as Record<string, unknown>, ["id", "threadId"], "research");
    const thread = threads.get(blob.threadId);
    if (!thread) invalid(blob.id, `unknown thread ${blob.threadId}`);
    list(blob.citations, `${blob.id}.citations`);
    for (const citation of blob.citations) {
      record(citation, `${blob.id}.citation`);
      fields(citation, ["title", "url", "highlight"], `${blob.id}.citation`);
    }
    if (blob.draftEmail !== undefined) {
      record(blob.draftEmail, `${blob.id}.draftEmail`);
      fields(blob.draftEmail, ["to", "subject", "body"], `${blob.id}.draftEmail`);
      if (blob.draftEmail.to !== thread!.commitTarget) invalid(blob.id, "draft recipient differs from thread commitTarget");
    }
    if (blob.draftStatus !== undefined) {
      record(blob.draftStatus, `${blob.id}.draftStatus`);
      fields(blob.draftStatus, ["visibility", "state", "body"], `${blob.id}.draftStatus`);
    }
    if (blob.draftEmail && blob.draftStatus) invalid(blob.id, "ambiguous outbound draft");
  }
  unique(pack.blobs.map((b) => b.id), "research IDs");
  unique(pack.blobs.map((b) => b.threadId), "research thread IDs");
  for (const [threadId, tasks] of Object.entries(pack.tasks)) {
    const thread = threads.get(threadId);
    if (!thread) invalid("tasks", `unknown thread ${threadId}`);
    list(tasks, `${threadId}.tasks`);
    for (const task of tasks) {
      record(task, `${threadId}.task`);
      fields(task, ["title", "assignee", "customerId"], `${threadId}.task`);
      knownUser(task.assignee, `${threadId}.task.assignee`);
      if (task.customerId !== thread!.customerId) invalid(threadId, "task belongs to another customer");
    }
  }
  for (const fixture of pack.fixtures) {
    fields(fixture as unknown as Record<string, unknown>, ["id", "threadId", "fixtureFor"], "fixture");
    safeId(fixture.id, "WO");
    const thread = threads.get(fixture.threadId);
    if (!thread?.customerId) invalid(fixture.id, `unknown or empty thread ${fixture.threadId}`);
    approvers(fixture.approvers, `${fixture.id}.approvers`);
    if (!fixture.approvers.length || fixture.approvers.some((id) => !thread!.approvers.includes(id))) {
      invalid(fixture.id, "fixture approvers must come from the thread allowlist");
    }
  }
  unique(pack.fixtures.map((f) => f.id), "fixture IDs");
  unique(pack.fixtures.map((f) => f.fixtureFor), "fixture beats");
  return structuredClone(pack);
}

let cache: DatasetPack | undefined;

function data() {
  cache ??= validateDatasetPack({
    threads: threadsJson.threads,
    customers: customersJson.customers,
    blobs: researchJson.blobs,
    tasks: tasksJson.templates,
    fixtures: fixturesJson.workOrders,
    users: usersJson.users,
  });
  return cache;
}

export function findThread(threadId: string): Thread | undefined {
  return structuredClone(data().threads.find((t) => t.id === threadId));
}

export function recoveryFixtures(): RecoveryFixture[] {
  return structuredClone(data().fixtures);
}

export function datasetUsers(): DatasetUser[] {
  return structuredClone(data().users);
}

/** Unknown/empty dataset scenarios throw rather than falling back to another customer. */
export function loadContext(scenario: string): Context | undefined {
  const thread = findThread(scenario);
  if (!thread && /^THREAD-/i.test(scenario)) throw new Error(`unknown dataset thread ${scenario}`);
  const customer = thread && data().customers.find((c) => c.id === thread.customerId);
  if (!thread) return undefined;
  if (!customer) throw new Error(`no customer on dataset thread ${scenario}`);
  return structuredClone({
    thread,
    customer,
    research: data().blobs.find((b) => b.threadId === thread.id),
    tasks: data().tasks[thread.id] ?? [],
  });
}

export function threadText(ctx: Context): string {
  return ctx.thread.messages.map((m) => `${m.user}: ${m.text}`).join("\n");
}

/** Thread constraints plus the account's standing doNot list, deduped case-insensitively. */
export function constraintsFor(ctx: Context): string[] {
  const all = [...ctx.thread.constraints, ...ctx.customer.doNot.map((d) => `do not ${d}`)];
  const seen = new Set<string>();
  return all.filter((c) => {
    const k = c.toLowerCase().trim();
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

export function stepsFor(ctx: Context): Step[] {
  if (!ctx.thread.commitTool) throw new Error(`no commitTool on ${ctx.thread.id}`);
  const step = (id: string, name: string, kind: Step["kind"], tool: string): Step => ({
    id,
    name,
    kind,
    tool,
    status: "pending",
    classifiedBy: "model",
  });
  return [
    step("1-read-thread", "Read thread and extract constraints", "reversible", "search"),
    step("2-research", "Research public language", "reversible", "search"),
    step("3-draft", "Draft the customer message into the work order", "reversible", "draft"),
    step("4-create-tasks", "Create follow-up tasks", "reversible", "tasks.create"),
    step("5-send-customer-update", "Send the customer message", "commit", ctx.thread.commitTool),
  ];
}

// Threads with no source draft in research_blobs.json. Built only from thread and customer fields.
const DRAFT_TEMPLATES: Record<string, (ctx: Context, to: Contact) => { subject: string; body: string }> = {
  refund_denial: (ctx, to) => ({
    subject: `${ctx.customer.name} — your service credit request`,
    body:
      `${to.name.split(" ")[0]} — thank you for raising this. We are not able to offer a service credit ` +
      `in writing through this channel. Any contractual question goes through the account's existing ` +
      `commercial process.\n\nMaya Chen, Customer Success`,
  }),
};

/** The grounded outbound draft, or an Error naming why none can be produced. */
export function draftFor(ctx: Context): { to: string; subject: string; body: string } | Error {
  if (ctx.research?.draftEmail) return ctx.research.draftEmail;
  if (ctx.research?.draftStatus) {
    return { to: ctx.thread.commitTarget ?? "", subject: `Status: ${ctx.research.draftStatus.state}`, body: ctx.research.draftStatus.body };
  }
  const template = DRAFT_TEMPLATES[ctx.thread.useCase];
  const to = ctx.customer.contacts.find((c) => c.email === ctx.thread.commitTarget);
  if (template && to) return { to: to.email, ...template(ctx, to) };
  return new Error(`no source draft for ${ctx.thread.id}`);
}
