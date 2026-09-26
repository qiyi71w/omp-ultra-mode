import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import proactivePolicy from "./prompts/proactive.md" with { type: "text" };

const AGENT = "omp-ultra";
const STATUS = "omp-ultra-mode";

export default function ultraMode(pi: ExtensionAPI): void {
  // Each child receives its own factory binding; never share a global mode flag.
  let enabled = false;

  function parentSelection(ctx: ExtensionContext): string | undefined {
    const model = ctx.model;
    if (!model) return undefined;
    const level = pi.getThinkingLevel();
    if (model.reasoning && (level === undefined || level === "inherit")) return undefined;
    return `${formatModelStringWithRouting(model)}:${level === undefined || level === "inherit" ? "off" : level}`;
  }

  function hasTask(): boolean {
    return pi.getActiveTools().includes("task");
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS, enabled ? (hasTask() ? "ULTRA" : "ULTRA · inline only") : undefined);
  }

  function setMode(value: boolean, ctx: ExtensionContext): void {
    enabled = value;
    updateStatus(ctx);
  }

  function enable(ctx: ExtensionContext): boolean {
    if (!hasTask()) {
      ctx.ui.notify("Ultra requires the native task tool. Enable task before turning Ultra on.", "error");
      return false;
    }
    if (!parentSelection(ctx)) {
      ctx.ui.notify("Ultra needs an active model and a resolved thinking level. Select them first.", "error");
      return false;
    }
    setMode(true, ctx);
    return true;
  }

  function report(ctx: ExtensionContext): void {
    const message = enabled
      ? `Ultra on · default child selection: ${parentSelection(ctx) ?? "unresolved"} · ${hasTask() ? "native task delegation" : "task unavailable; work inline"}. Explicit native effort overrides still apply. Parallel agents consume additional tokens.`
      : "Ultra off. Existing agent templates and model settings are unchanged.";
    ctx.ui.notify(message, "info");
  }

  pi.setLabel("OMP Ultra Mode");
  pi.registerFlag("ultra", {
    description: "Enable proactive native task delegation, inheriting the current model and thinking level",
    type: "boolean",
    default: false,
  });
  pi.registerCommand("ultra", {
    description: "Toggle proactive delegation: /ultra [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || (enabled ? "off" : "on");
      if (action === "status") {
        updateStatus(ctx);
        report(ctx);
        return;
      }
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /ultra [on|off|status]", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current run to finish before switching Ultra mode.", "warning");
        return;
      }
      if (action === "on") {
        if (!enable(ctx)) return;
      } else {
        setMode(false, ctx);
      }
      report(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const ultraChild = ctx.agent.kind === "sub" && ctx.agent.name === AGENT;
    setMode(ultraChild, ctx);
    if (ctx.agent.kind === "main" && pi.getFlag("ultra") === true) enable(ctx);
  });
  pi.on("session_switch", (_event, ctx) => setMode(false, ctx));
  pi.on("session_branch", (_event, ctx) => setMode(false, ctx));
  pi.on("session_shutdown", (_event, ctx) => setMode(false, ctx));

  pi.on("before_agent_start", (event, ctx) => {
    updateStatus(ctx);
    if (!enabled || !hasTask()) return;
    return { systemPrompt: [...event.systemPrompt, proactivePolicy] };
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    if (event.agent !== AGENT) return;
    if (!enabled) {
      return { block: true, reason: "omp-ultra requires /ultra on in the spawning session." };
    }
    const selection = parentSelection(ctx);
    if (!selection) {
      return { block: true, reason: "Cannot inherit the parent's active model and resolved thinking level." };
    }
    return {
      model: selection,
      note: `Ultra inherits ${selection}; an explicit native effort parameter takes precedence.`,
    };
  });
}
