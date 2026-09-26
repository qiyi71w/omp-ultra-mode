import { afterAll, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

// Isolate discovery before importing OMP, which caches some environment paths.
const root = await mkdtemp(join(tmpdir(), "omp-ultra-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { AuthStorage, SqliteAuthCredentialStore, ModelRegistry, Settings, SessionManager, createAgentSession } =
  await import("@oh-my-pi/pi-coding-agent");
const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
const { initializeExtensions } = await import("@oh-my-pi/pi-coding-agent/modes/runtime-init");
const { cfgTaskEnableEffort, cfgTaskMaxEffort } = await import("@oh-my-pi/pi-coding-agent/task/settings");
const { createAssistantMessageEventStream } = await import("@oh-my-pi/pi-ai");

const cwd = join(root, "workspace");
await mkdir(join(cwd, ".omp", "agents"), { recursive: true });
await Bun.write(join(cwd, ".omp", "agents", "ordinary.md"), `---
name: ordinary
description: Ordinary configured worker.
model: ultra-test/secondary
thinking-level: low
---
Complete the assigned task and yield its result.
`);

const settings = Settings.isolated({
  "async.enabled": false,
  "task.enableLsp": false,
  "task.maxRecursionDepth": 2,
  "task.enableEffort": false,
  "task.agentModelOverrides": { "omp-ultra": "ultra-test/secondary:low" },
});
const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
const registry = new ModelRegistry(auth, join(root, "models.yml"), { settings });
const calls: Array<{ model: string; reasoning: string | undefined; child: boolean }> = [];
let nextTasks: Array<{ agent: string; task: string; effort?: "lo" | "hi" }> | undefined;
let sequence = 0;

function stream(model: Model, context: Context, options?: SimpleStreamOptions) {
  const child = context.tools?.some(tool => tool.name === "yield") ?? false;
  calls.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning, child });
  const tasks = child ? undefined : nextTasks;
  if (!child) nextTasks = undefined;
  const content: AssistantMessage["content"] = child
    ? [{ type: "toolCall", id: `yield-${++sequence}`, name: "yield", arguments: { data: { completed: true } } }]
    : tasks
      ? [{ type: "toolCall", id: `task-${++sequence}`, name: "task", arguments: { context: "Offline inheritance verification", tasks } }]
      : [{ type: "text", text: "Offline turn complete." }];
  const message: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, content,
    stopReason: child || tasks ? "toolUse" : "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const events = createAssistantMessageEventStream();
  events.push({ type: "start", partial: message });
  for (const [contentIndex, block] of content.entries()) {
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex, partial: message });
      events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial: message });
      events.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
    } else if (block.type === "text") {
      events.push({ type: "text_start", contentIndex, partial: message });
      events.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      events.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    }
  }
  events.push({ type: "done", reason: child || tasks ? "toolUse" : "stop", message });
  events.end(message);
  return events;
}

registry.registerProvider("ultra-test", {
  api: "ultra-test-api", apiKey: "offline-test-key", baseUrl: "http://127.0.0.1:1",
  streamSimple: stream,
  models: ["primary", "secondary"].map(id => ({
    id, name: id, reasoning: true,
    thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max], defaultLevel: Effort.Medium },
    input: ["text"], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
});
const errors: string[] = [];
const { session } = await createAgentSession({
  cwd, agentDir: join(root, "agent"), settings, authStorage: auth, modelRegistry: registry,
  model: registry.find("ultra-test", "primary"), thinkingLevel: Effort.High,
  sessionManager: SessionManager.inMemory(cwd), agentRegistry: new AgentRegistry(),
  additionalExtensionPaths: [resolve(import.meta.dir, "..")], disableExtensionDiscovery: true,
  enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
  skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
  toolNames: ["task"],
});
await initializeExtensions(session, {
  reportSendError: (_action, error) => errors.push(error.message),
  reportRuntimeError: error => errors.push(error.error),
});

beforeEach(async () => {
  await session.newSession();
  const primary = registry.find("ultra-test", "primary");
  if (!primary) throw new Error("Missing offline primary model");
  await session.setModel(primary, undefined, { persist: false });
  session.setThinkingLevel(Effort.High, false);
  calls.length = 0;
  errors.length = 0;
  nextTasks = undefined;
});

afterAll(async () => {
  await session.dispose();
  registry.unregisterProvider("ultra-test");
  auth.close();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("Ultra inherits the live parent selection without changing an ordinary agent", async () => {
  await session.prompt("/ultra on");
  nextTasks = [
    { agent: "omp-ultra", task: "Complete the Ultra assignment." },
    { agent: "ordinary", task: "Complete the ordinary assignment." },
  ];
  await session.prompt("Run both assignments.");
  expect(errors).toEqual([]);
  expect(calls.filter(call => call.child).sort((a, b) => a.model.localeCompare(b.model))).toEqual([
    { model: "ultra-test/primary", reasoning: "high", child: true },
    { model: "ultra-test/secondary", reasoning: "low", child: true },
  ]);
  expect(session.model?.id).toBe("primary");
  expect(session.thinkingLevel).toBe(Effort.High);
}, 30000);

test("Ultra follows live model changes and preserves explicit native effort precedence", async () => {
  calls.length = 0;
  await session.prompt("/ultra on");
  const secondary = registry.find("ultra-test", "secondary");
  if (!secondary) throw new Error("Missing offline secondary model");
  await session.setModel(secondary, undefined, { persist: false });
  session.setThinkingLevel(Effort.Max, false);
  nextTasks = [{ agent: "omp-ultra", task: "Use the current parent selection." }];
  await session.prompt("Run the assignment after switching models.");
  expect(calls.filter(call => call.child)).toEqual([
    { model: "ultra-test/secondary", reasoning: "max", child: true },
  ]);

  calls.length = 0;
  cfgTaskEnableEffort.override(settings, true);
  cfgTaskMaxEffort.override(settings, Effort.Medium);
  try {
    nextTasks = [{ agent: "omp-ultra", task: "Use the explicit native effort override.", effort: "hi" }];
    await session.prompt("Run with the explicitly requested effort.");
    expect(calls.filter(call => call.child)).toEqual([
      { model: "ultra-test/secondary", reasoning: "medium", child: true },
    ]);
    expect(session.model?.id).toBe("secondary");
    expect(session.thinkingLevel).toBe(Effort.Max);
  } finally {
    cfgTaskEnableEffort.override(settings, false);
    cfgTaskMaxEffort.override(settings, Effort.Max);
  }
}, 30000);

test("Turning Ultra off blocks its reserved agent without disabling ordinary workers", async () => {
  calls.length = 0;
  await session.prompt("/ultra off");
  nextTasks = [
    { agent: "omp-ultra", task: "This assignment must be blocked." },
    { agent: "ordinary", task: "This ordinary assignment remains available." },
  ];
  await session.prompt("Run the assignments with Ultra disabled.");
  expect(calls.filter(call => call.child)).toEqual([
    { model: "ultra-test/secondary", reasoning: "low", child: true },
  ]);
}, 30000);

test("A new session resets Ultra mode instead of leaking the previous session's opt-in", async () => {
  await session.prompt("/ultra on");
  await session.newSession();
  calls.length = 0;
  nextTasks = [{ agent: "omp-ultra", task: "Do not inherit another session's opt-in." }];
  await session.prompt("Try the reserved agent in the new session.");
  expect(calls.filter(call => call.child)).toEqual([]);
  expect(errors).toEqual([]);
}, 30000);
