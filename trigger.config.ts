import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_rghkywrsmyalnxjbareu",
  runtime: "node-22",
  logLevel: "log",
  maxDuration: 300,
  // Retries off in dev: a kill should read as "cancelled, then resumed by a new
  // trigger", not as three confusing attempts on screen.
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
  dirs: ["./src/trigger"],
});
