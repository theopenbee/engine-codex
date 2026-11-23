import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildTranscript, commandSummary } from "../dist/transcript.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "transcript", "codex.jsonl");
const scratch = mkdtempSync(join(tmpdir(), "engine-codex-transcript-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function logOf(...events) {
  const path = join(scratch, `log-${++counter}.jsonl`);
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return path;
}

test("the fixture log becomes the full step list", () => {
  assert.deepEqual(buildTranscript(fixture), [
    { type: "text", text: "I will look at the project layout first.\n\nThen I will read the notes." },
    { type: "thinking", text: "Listing the directory is the cheapest first step." },
    { type: "tool", kind: "message", name: "send_message", summary: "Looking at the layout now.", output: '{"status":"sent"}', status: "done" },
    {
      type: "tool",
      kind: "command",
      name: "shell",
      summary: "ls -la",
      output: "total 8\n-rw-r--r--  1 user  staff  12 Jan  1 00:00 notes.txt",
      status: "done",
    },
    { type: "tool", kind: "command", name: "shell", summary: "cat missing.txt", output: "cat: missing.txt: No such file or directory", status: "error" },
    { type: "tool", kind: "command", name: "shell", summary: "grep -q needle notes.txt", status: "error" },
    { type: "tool", kind: "command", name: "shell", summary: "echo done", output: "done", status: "done" },
    { type: "tool", kind: "other", name: "execute", summary: "return 1 + 1;", output: "first block\nsecond block", status: "done" },
    { type: "tool", kind: "other", name: "execute", summary: "return secret();", output: "permission denied", status: "error" },
    { type: "tool", kind: "edit", name: "apply_patch", summary: "/work/demo/a.txt, /work/demo/b.txt", status: "done" },
    { type: "tool", kind: "edit", name: "apply_patch", summary: "/work/demo/c.txt", status: "error" },
    { type: "tool", kind: "web", name: "web_search", summary: "codex exec json output", status: "done" },
    { type: "tool", kind: "web", name: "web_search", summary: "https://example.com/docs", status: "done" },
    { type: "tool", kind: "other", name: "spawn_agent", summary: "Review the notes.", status: "done" },
    { type: "text", text: "All done." },
    { type: "tool", kind: "command", name: "shell", summary: "sleep 60", status: "running" },
    { type: "error", text: "Reconnecting... 1/5 (network unreachable)" },
    { type: "error", text: "model overloaded" },
  ]);
});

test("a missing log has no steps", () => {
  assert.deepEqual(buildTranscript(join(scratch, "missing.log")), []);
});

test("turn.failed without a preceding error reports its message", () => {
  const path = logOf({ type: "turn.started" }, { type: "turn.failed", error: { message: "quota exceeded" } });
  assert.deepEqual(buildTranscript(path), [{ type: "error", text: "quota exceeded" }]);
});

test("turn.failed with a different message than the last error is reported too", () => {
  const path = logOf({ type: "error", message: "first" }, { type: "turn.failed", error: { message: "second" } });
  assert.deepEqual(buildTranscript(path), [
    { type: "error", text: "first" },
    { type: "error", text: "second" },
  ]);
});

test("error events without a message are skipped", () => {
  const path = logOf({ type: "error" }, { type: "turn.failed", error: {} }, { type: "turn.failed" });
  assert.deepEqual(buildTranscript(path), []);
});

test("item.updated never creates or changes a step", () => {
  const item = { id: "item_0", type: "command_execution", command: "ls", aggregated_output: "x", exit_code: null, status: "in_progress" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.updated", item })), []);
});

test("a tool item without an id is ignored", () => {
  const item = { type: "command_execution", command: "ls", aggregated_output: "x", exit_code: 0, status: "completed" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.completed", item })), []);
});

test("an mcp tool call without a tool name is ignored", () => {
  const item = { id: "item_0", type: "mcp_tool_call", server: "openbee", arguments: {}, status: "completed" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.completed", item })), []);
});

test("unknown item types are skipped", () => {
  const item = { id: "item_0", type: "something_new", text: "x" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.started", item }, { type: "item.completed", item })), []);
});

test("agent messages without text are skipped", () => {
  const path = logOf(
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message" } },
    { type: "item.started", item: { id: "item_2", type: "agent_message", text: "not completed" } },
    { type: "item.completed", item: { id: "item_3", type: "reasoning", text: "  " } },
  );
  assert.deepEqual(buildTranscript(path), []);
});

test("a started tool that never completes keeps running", () => {
  const item = { id: "item_0", type: "mcp_tool_call", server: "openbee", tool: "execute", arguments: { code: "wait()" }, result: null, error: null, status: "in_progress" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.started", item })), [
    { type: "tool", kind: "other", name: "execute", summary: "wait()", status: "running" },
  ]);
});

test("an mcp tool call uses the first string argument as its summary", () => {
  const item = { id: "item_0", type: "mcp_tool_call", server: "x", tool: "lookup", arguments: { limit: 5, query: "bees", other: "later" }, status: "completed" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.completed", item })), [
    { type: "tool", kind: "other", name: "lookup", summary: "bees", status: "done" },
  ]);
});

test("an mcp tool call without string arguments has no summary", () => {
  const item = { id: "item_0", type: "mcp_tool_call", server: "x", tool: "ping", arguments: { limit: 5 }, status: "completed" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.completed", item })), [{ type: "tool", kind: "other", name: "ping", status: "done" }]);
});

test("an mcp tool call error given as a string is the output", () => {
  const item = { id: "item_0", type: "mcp_tool_call", server: "x", tool: "ping", arguments: {}, result: null, error: "boom", status: "completed" };
  assert.deepEqual(buildTranscript(logOf({ type: "item.completed", item })), [{ type: "tool", kind: "other", name: "ping", output: "boom", status: "error" }]);
});

test("commandSummary removes the login shell wrapper and its quotes", () => {
  assert.equal(commandSummary("/bin/zsh -lc 'ls -la'"), "ls -la");
  assert.equal(commandSummary('/bin/zsh -lc "rg -n \'a|b\' src"'), "rg -n 'a|b' src");
  assert.equal(commandSummary("/bin/bash -lc 'git status'"), "git status");
  assert.equal(commandSummary('bash -lc "echo hi"'), "echo hi");
  assert.equal(commandSummary("zsh -lc 'pwd'"), "pwd");
  assert.equal(commandSummary("/bin/zsh -lc ls"), "ls");
});

test("commandSummary keeps commands without a wrapper and unmatched quotes", () => {
  assert.equal(commandSummary("echo done"), "echo done");
  assert.equal(commandSummary("'a' 'b'"), "'a' 'b'");
  assert.equal(commandSummary("'quoted' tail"), "'quoted' tail");
  assert.equal(commandSummary("/bin/zsh -lc 'unterminated"), "'unterminated");
  assert.equal(commandSummary("/bin/zsh -lc 'a\""), "'a\"");
  assert.equal(commandSummary("/bin/zsh -lc '"), "'");
  assert.equal(commandSummary(undefined), "");
});
