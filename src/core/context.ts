// Customer context from the imported datasets/ pack. A work order whose `scenario` is a
// dataset thread id is grounded in that thread; any other scenario keeps the fixture stub.
import { readFileSync } from "node:fs";

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

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../datasets/${file}`, import.meta.url), "utf8")) as T;

let cache:
  | {
      threads: Thread[];
      customers: Customer[];
      blobs: Research[];
      tasks: Record<string, TaskTemplate[]>;
      fixtures: RecoveryFixture[];
    }
  | undefined;

function data() {
  cache ??= {
    threads: read<{ threads: Thread[] }>("threads.json").threads,
    customers: read<{ customers: Customer[] }>("customers.json").customers,
    blobs: read<{ blobs: Research[] }>("research_blobs.json").blobs,
    tasks: read<{ templates: Record<string, TaskTemplate[]> }>("tasks_seed.json").templates,
    fixtures: read<{ workOrders: RecoveryFixture[] }>("work_order_fixtures.json").workOrders,
  };
  return cache;
}

export function findThread(threadId: string): Thread | undefined {
  return data().threads.find((t) => t.id === threadId);
}

export function recoveryFixtures(): RecoveryFixture[] {
  return data().fixtures;
}

/** Undefined for non-dataset scenarios and for threads with no customer (THREAD-EMPTY). */
export function loadContext(scenario: string): Context | undefined {
  const thread = findThread(scenario);
  const customer = thread && data().customers.find((c) => c.id === thread.customerId);
  if (!thread || !customer) return undefined;
  return {
    thread,
    customer,
    research: data().blobs.find((b) => b.threadId === thread.id),
    tasks: data().tasks[thread.id] ?? [],
  };
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
    step("5-send-customer-update", "Send the customer message", "commit", ctx.thread.commitTool ?? "mail.send"),
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
