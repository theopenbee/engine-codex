import { TranscriptBuilder, readJsonLines } from "@theopenbee/engine-sdk";
import type { ToolKind, TranscriptStep } from "@theopenbee/engine-sdk";

type JsonObject = Record<string, unknown>;

interface ToolSpec {
  kind: ToolKind;
  name: string;
  summary: string;
}

interface ToolResult {
  output: string;
  isError: boolean;
}

const SHELL_WRAPPER = /^(?:\/bin\/)?(?:zsh|bash) -lc /;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(value: unknown): string {
  if (!isObject(value)) return "";
  for (const entry of Object.values(value)) {
    if (typeof entry === "string") return entry;
  }
  return "";
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  return isObject(value) ? stringOf(value.message) : "";
}

function changedPaths(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  return changes
    .map((change) => (isObject(change) ? stringOf(change.path) : ""))
    .filter((path) => path !== "")
    .join(", ");
}

function resultText(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) return "";
  return result.content
    .flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

export function commandSummary(command: unknown): string {
  const text = stringOf(command);
  const wrapper = SHELL_WRAPPER.exec(text);
  if (!wrapper) return text;
  const rest = text.slice(wrapper[0].length);
  const quote = rest[0];
  if (rest.length >= 2 && (quote === "'" || quote === '"') && rest.endsWith(quote)) return rest.slice(1, -1);
  return rest;
}

function describeTool(item: JsonObject): ToolSpec | undefined {
  switch (item.type) {
    case "command_execution":
      return { kind: "command", name: "shell", summary: commandSummary(item.command) };
    case "mcp_tool_call": {
      const tool = stringOf(item.tool);
      if (tool === "") return undefined;
      if (tool === "send_message") {
        return { kind: "message", name: tool, summary: isObject(item.arguments) ? stringOf(item.arguments.content) : "" };
      }
      return { kind: "other", name: tool, summary: firstString(item.arguments) };
    }
    case "file_change":
      return { kind: "edit", name: "apply_patch", summary: changedPaths(item.changes) };
    case "web_search":
      return { kind: "web", name: "web_search", summary: stringOf(item.query) || (isObject(item.action) ? stringOf(item.action.url) : "") };
    case "collab_tool_call": {
      const tool = stringOf(item.tool);
      return tool === "" ? undefined : { kind: "other", name: tool, summary: stringOf(item.prompt) };
    }
    default:
      return undefined;
  }
}

function toolResult(item: JsonObject): ToolResult {
  const failed = item.status === "failed";
  if (item.type === "command_execution") {
    const code = item.exit_code;
    return { output: stringOf(item.aggregated_output), isError: failed || (typeof code === "number" && code !== 0) };
  }
  if (item.type === "mcp_tool_call") {
    const message = errorText(item.error);
    return { output: message !== "" ? message : resultText(item.result), isError: failed || message !== "" };
  }
  return { output: "", isError: failed };
}

export function buildTranscript(logPath: string): TranscriptStep[] {
  const events = readJsonLines(logPath);
  const completed = new Map<string, JsonObject>();
  for (const event of events) {
    if (event.type === "item.completed" && isObject(event.item) && typeof event.item.id === "string") {
      completed.set(event.item.id, event.item);
    }
  }

  const builder = new TranscriptBuilder();
  const open = new Set<string>();
  let lastError = "";

  for (const event of events) {
    const item = isObject(event.item) ? event.item : undefined;
    if (event.type === "error") {
      lastError = errorText(event.message);
      if (lastError !== "") builder.error(lastError);
    } else if (event.type === "turn.failed") {
      const message = errorText(event.error);
      if (message !== "" && message !== lastError) builder.error(message);
    } else if (item && event.type === "item.started") {
      const id = stringOf(item.id);
      const spec = describeTool(completed.get(id) ?? item);
      if (id !== "" && spec) {
        builder.toolStart(id, spec);
        open.add(id);
      }
    } else if (item && event.type === "item.completed") {
      if (item.type === "agent_message") {
        builder.text(stringOf(item.text));
      } else if (item.type === "reasoning") {
        builder.thinking(stringOf(item.text));
      } else {
        const id = stringOf(item.id);
        const spec = describeTool(item);
        if (id !== "" && spec) {
          if (!open.has(id)) builder.toolStart(id, spec);
          builder.toolEnd(id, toolResult(item));
          open.delete(id);
        }
      }
    }
  }

  return builder.steps();
}
