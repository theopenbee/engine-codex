import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SessionStore,
  buildArgs,
  codexBaseDir,
  collectUsage,
  extractResultFromLog,
  failureText,
  findCodexSessionFile,
  goQuote,
  mcpArgs,
  openSessionStore,
  threadIdFromLine,
} from "../dist/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const logs = join(here, "fixtures", "logs");
const scratch = mkdtempSync(join(tmpdir(), "engine-codex-unit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir, relative, content) {
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

const FIXED = ["--json", "--dangerously-bypass-approvals-and-sandbox"];

test("buildArgs for a new session reads the prompt from stdin", () => {
  assert.deepEqual(buildArgs("", false, "", []), ["exec", "-", ...FIXED]);
});

test("buildArgs for a new session does not put the prompt in the arguments", () => {
  assert.deepEqual(buildArgs("", false, "do something", []), ["exec", "-", ...FIXED]);
});

test("buildArgs resumes a thread without a prompt", () => {
  assert.deepEqual(buildArgs("sess-123", true, "", []), ["exec", "resume", "sess-123", ...FIXED]);
});

test("buildArgs resumes a thread with the prompt as the last argument", () => {
  assert.deepEqual(buildArgs("sess-123", true, "do something", []), ["exec", "resume", "sess-123", ...FIXED, "do something"]);
});

test("buildArgs resume uses the thread id from the mapping", () => {
  assert.deepEqual(buildArgs("thread-xyz-from-store", true, "follow up", []), [
    "exec",
    "resume",
    "thread-xyz-from-store",
    ...FIXED,
    "follow up",
  ]);
});

test("buildArgs starts a new session when resume has no thread id", () => {
  assert.deepEqual(buildArgs("", true, "follow up", []), ["exec", "-", ...FIXED]);
});

test("buildArgs ignores the thread id when not resuming", () => {
  assert.deepEqual(buildArgs("sess-123", false, "hi", []), ["exec", "-", ...FIXED]);
});

test("buildArgs appends extra args after the fixed flags of a new session", () => {
  assert.deepEqual(buildArgs("", false, "hi", ["--model", "gpt-5"]), ["exec", "-", ...FIXED, "--model", "gpt-5"]);
});

test("buildArgs appends extra args after the prompt of a resume", () => {
  assert.deepEqual(buildArgs("t1", true, "hi", ["-c", "a=1"]), ["exec", "resume", "t1", ...FIXED, "hi", "-c", "a=1"]);
});

test("mcpArgs is empty without an MCP address", () => {
  assert.deepEqual(mcpArgs(undefined), []);
  assert.deepEqual(mcpArgs({ name: "openbee", url: "", api_key_env: "OPENBEE_API_KEY" }), []);
});

test("mcpArgs sets the url and the bearer token variable", () => {
  assert.deepEqual(mcpArgs({ name: "openbee", url: "http://127.0.0.1:9000/mcp", api_key_env: "OPENBEE_API_KEY" }), [
    "-c",
    'mcp_servers.openbee.url="http://127.0.0.1:9000/mcp"',
    "-c",
    'mcp_servers.openbee.bearer_token_env_var="OPENBEE_API_KEY"',
  ]);
});

test("mcpArgs uses the server name and key variable from the request", () => {
  assert.deepEqual(mcpArgs({ name: "bee-mcp", url: "http://h:1/mcp", api_key_env: "BEE_TOKEN" }), [
    "-c",
    'mcp_servers.bee-mcp.url="http://h:1/mcp"',
    "-c",
    'mcp_servers.bee-mcp.bearer_token_env_var="BEE_TOKEN"',
  ]);
});

test("mcpArgs quotes the values like strconv.Quote", () => {
  const args = mcpArgs({ name: "openbee", url: 'http://h/mcp?q="a"&b=\\', api_key_env: "K\n" });
  assert.equal(args[1], 'mcp_servers.openbee.url="http://h/mcp?q=\\"a\\"&b=\\\\"');
  assert.equal(args[3], 'mcp_servers.openbee.bearer_token_env_var="K\\n"');
});

const QUOTE_VECTORS = [
  ["http://127.0.0.1:9000/mcp", '"http://127.0.0.1:9000/mcp"'],
  ["", '""'],
  ['say "hi" \\ there', '"say \\"hi\\" \\\\ there"'],
  ["line\nbreak\ttab\rcr", '"line\\nbreak\\ttab\\rcr"'],
  ["\x07\b\f\v", '"\\a\\b\\f\\v"'],
  ["\x00\x01\x1f\x7f", '"\\x00\\x01\\x1f\\x7f"'],
  ["café 你好", '"café 你好"'],
  ["\u{1F41D} bee", '"\u{1F41D} bee"'],
  ["nbsp here", '"nbsp\\u00a0here"'],
  ["sep  ", '"sep\\u2028\\u2029"'],
  ["bom﻿", '"bom\\ufeff"'],
  ["zw​", '"zw\\u200b"'],
  ["\u0085", '"\\u0085"'],
  ["­", '"\\u00ad"'],
  ["͸", '"\\u0378"'],
  ["\u{e0001}", '"\\U000e0001"'],
  ["\u{100000}", '"\\U00100000"'],
  ["'single' `tick` $HOME", "\"'single' `tick` $HOME\""],
];

for (const [input, expected] of QUOTE_VECTORS) {
  test(`goQuote matches strconv.Quote for ${JSON.stringify(input)}`, () => {
    assert.equal(goQuote(input), expected);
  });
}

test("threadIdFromLine reads the thread.started event", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"019d7293-0a51-71e0-b634-02183839d7b2"}',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{}}',
  ];
  assert.deepEqual(stream.map(threadIdFromLine), ["019d7293-0a51-71e0-b634-02183839d7b2", "", ""]);
});

test("threadIdFromLine ignores noise and other events", () => {
  assert.equal(threadIdFromLine(""), "");
  assert.equal(threadIdFromLine("warning: thread.started"), "");
  assert.equal(threadIdFromLine("{broken"), "");
  assert.equal(threadIdFromLine("[1]"), "");
  assert.equal(threadIdFromLine('{"type":"thread.started"}'), "");
  assert.equal(threadIdFromLine('{"type":"thread.started","thread_id":""}'), "");
  assert.equal(threadIdFromLine('{"type":"thread.started","thread_id":7}'), "");
  assert.equal(threadIdFromLine('{"type":"turn.started","thread_id":"x"}'), "");
});

test("threadIdFromLine accepts indented lines", () => {
  assert.equal(threadIdFromLine('  \t{"type":"thread.started","thread_id":"t-1"}  '), "t-1");
});

const extract = (name) => extractResultFromLog(join(logs, name));

test("extractResultFromLog returns the agent message", async () => {
  assert.equal(await extract("basic.jsonl"), "hello world");
});

test("extractResultFromLog returns the last agent message", async () => {
  assert.equal(await extract("last-agent-message.jsonl"), "final answer");
});

test("extractResultFromLog keeps the last non-empty agent message", async () => {
  assert.equal(await extract("empty-text.jsonl"), "kept");
});

test("extractResultFromLog only counts completed agent messages", async () => {
  assert.equal(await extract("other-items.jsonl"), "");
});

test("extractResultFromLog skips noise and malformed lines", async () => {
  assert.equal(await extract("noisy.jsonl"), "after noise");
});

test("extractResultFromLog handles CRLF line endings", async () => {
  const content = [
    '{"type":"thread.started","thread_id":"abc"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"crlf answer"}}',
    "",
  ].join("\r\n");
  assert.equal(await extractResultFromLog(writeFile(freshDir("crlf"), "exec.log", content)), "crlf answer");
});

test("extractResultFromLog is empty without an agent message", async () => {
  assert.equal(await extract("no-agent-message.jsonl"), "");
});

test("extractResultFromLog is empty for an empty file", async () => {
  assert.equal(await extract("empty.jsonl"), "");
});

test("extractResultFromLog is empty for a missing file", async () => {
  assert.equal(await extractResultFromLog(join(scratch, "no-such.log")), "");
});

test("extractResultFromLog reads very long lines", async () => {
  const text = "x".repeat(3 * 1024 * 1024);
  const path = writeFile(freshDir("long"), "exec.log", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
  assert.equal((await extractResultFromLog(path)).length, text.length);
});

test("failureText reports the exit code", () => {
  assert.equal(failureText(2, null, ""), "codex exited with code 2");
  assert.equal(failureText(1, null, "  \n\n"), "codex exited with code 1");
});

test("failureText appends the last non-empty stderr line", () => {
  assert.equal(failureText(1, null, "first\nsecond\n\n  \n"), "codex exited with code 1: second");
  assert.equal(failureText(1, null, "  boom  \r\n"), "codex exited with code 1: boom");
});

test("failureText reports a signal", () => {
  assert.equal(failureText(null, "SIGKILL", ""), "codex was terminated by signal SIGKILL");
  assert.equal(failureText(null, "SIGTERM", "killed\n"), "codex was terminated by signal SIGTERM: killed");
  assert.equal(failureText(null, null, ""), "codex was terminated by signal unknown");
});

test("session store get is false for a missing session", () => {
  const store = new SessionStore(freshDir("store"));
  assert.equal(store.get("nonexistent-uuid"), undefined);
});

test("session store set then get", () => {
  const dir = freshDir("store");
  const store = new SessionStore(dir);
  store.set("openbee-uuid-1", "codex-thread-abc");
  assert.equal(store.get("openbee-uuid-1"), "codex-thread-abc");
  assert.equal(readFileSync(join(dir, "openbee-uuid-1"), "utf8"), "codex-thread-abc");
});

test("session store set overwrites the previous thread", () => {
  const store = new SessionStore(freshDir("store"));
  store.set("uuid-1", "thread-v1");
  store.set("uuid-1", "thread-v2");
  assert.equal(store.get("uuid-1"), "thread-v2");
});

test("session store set leaves no temp file behind", () => {
  const dir = freshDir("store");
  new SessionStore(dir).set("uuid-atomic", "thread-xyz");
  assert.deepEqual(readdirSync(dir), ["uuid-atomic"]);
});

test("session store set cleans up its temp file when the rename fails", () => {
  const dir = freshDir("store");
  mkdirSync(join(dir, "uuid-dir"));
  assert.throws(() => new SessionStore(dir).set("uuid-dir", "thread"));
  assert.deepEqual(readdirSync(dir), ["uuid-dir"]);
});

test("openSessionStore creates a missing directory", () => {
  const dir = join(freshDir("parent"), "deep", "sessions");
  const store = openSessionStore(dir);
  assert.ok(statSync(dir).isDirectory());
  store.set("s1", "t1");
  assert.equal(store.get("s1"), "t1");
});

test("session store get trims whitespace around the thread id", () => {
  const dir = freshDir("store");
  writeFileSync(join(dir, "legacy"), "codex-real-sess-1\n");
  assert.equal(new SessionStore(dir).get("legacy"), "codex-real-sess-1");
});

test("session store get treats an empty or blank file as missing", () => {
  const dir = freshDir("store");
  writeFileSync(join(dir, "empty"), "");
  writeFileSync(join(dir, "blank"), " \n\t\n");
  const store = new SessionStore(dir);
  assert.equal(store.get("empty"), undefined);
  assert.equal(store.get("blank"), undefined);
});

test("session store refuses ids that are not plain file names", () => {
  const parent = freshDir("parent");
  const dir = join(parent, "sessions");
  mkdirSync(dir);
  writeFileSync(join(parent, "outside"), "secret-thread");
  const store = new SessionStore(dir);
  for (const id of ["", ".", "..", "../outside", "a/b", "a\\b", "a\0b"]) {
    assert.equal(store.get(id), undefined, JSON.stringify(id));
    assert.throws(() => store.set(id, "t"), /invalid session id/, JSON.stringify(id));
  }
  assert.equal(readFileSync(join(parent, "outside"), "utf8"), "secret-thread");
  assert.deepEqual(readdirSync(dir), []);
});

test("codexBaseDir uses CODEX_HOME when set", () => {
  assert.equal(codexBaseDir({ CODEX_HOME: "/custom/codex" }, "/home/me"), "/custom/codex");
});

test("codexBaseDir defaults to ~/.codex", () => {
  assert.equal(codexBaseDir({}, "/home/me"), join("/home/me", ".codex"));
  assert.equal(codexBaseDir({ CODEX_HOME: "" }, "/home/me"), join("/home/me", ".codex"));
});

function usageSetup() {
  const base = freshDir("usage");
  const mappingDir = join(base, "mapping");
  const codexBase = join(base, "codex");
  mkdirSync(mappingDir, { recursive: true });
  mkdirSync(join(codexBase, "sessions"), { recursive: true });
  return { mappingDir, codexBase, store: new SessionStore(mappingDir) };
}

const usageLines = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const turnContext = (model) => ({ type: "turn_context", payload: { model } });
const tokenCount = (info) => ({ type: "event_msg", payload: { type: "token_count", info } });
const counts = (input_tokens, output_tokens, cached_input_tokens) => ({ input_tokens, output_tokens, cached_input_tokens });
const usage = (model, input_tokens, output_tokens, cache_read_tokens) => ({
  model,
  input_tokens,
  output_tokens,
  cache_creation_tokens: 0,
  cache_read_tokens,
});

async function collectOne(content, extraSetup) {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "openbee-sess"), "codex-real-sess");
  writeFile(join(codexBase, "sessions"), "codex-real-sess.jsonl", content);
  if (extraSetup) extraSetup({ mappingDir, codexBase });
  const result = await collectUsage(store, codexBase, ["openbee-sess"]);
  return result["openbee-sess"];
}

test("usage sums last_token_usage per model across model switches", async () => {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "openbee-sess-1"), "codex-real-sess-1\n");
  writeFile(
    join(codexBase, "sessions", "2026", "04", "23"),
    "rollout-2026-04-23T01-02-03-codex-real-sess-1.jsonl",
    `{"type":"turn_context","payload":{"model":"gpt-4o"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":20},"total_token_usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":20}}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"output_tokens":80,"cached_input_tokens":10},"total_token_usage":{"input_tokens":300,"output_tokens":130,"cached_input_tokens":30}}}}
{"type":"turn_context","payload":{"model":"o1-mini"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":300,"output_tokens":100,"cached_input_tokens":0},"total_token_usage":{"input_tokens":600,"output_tokens":230,"cached_input_tokens":30}}}}
`,
  );
  const result = await collectUsage(store, codexBase, ["openbee-sess-1"]);
  const byModel = Object.fromEntries(result["openbee-sess-1"].map((u) => [u.model, u]));
  assert.deepEqual(byModel["gpt-4o"], usage("gpt-4o", 300, 130, 30));
  assert.deepEqual(byModel["o1-mini"], usage("o1-mini", 300, 100, 0));
  assert.equal(result["openbee-sess-1"].length, 2);
});

test("usage takes the delta of total_token_usage when there is no last_token_usage", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("gpt-4o"),
      { type: "event_msg", info: { total_token_usage: counts(100, 50, 10) } },
      { type: "event_msg", info: { total_token_usage: counts(250, 120, 25) } },
    ),
  );
  assert.deepEqual(result, [usage("gpt-4o", 250, 120, 25)]);
});

test("usage reads a top-level info object (legacy layout)", async () => {
  const result = await collectOne(usageLines(turnContext("gpt-4o"), { type: "event_msg", info: { last_token_usage: counts(100, 50, 10) } }));
  assert.deepEqual(result, [usage("gpt-4o", 100, 50, 10)]);
});

test("usage prefers payload.info over the top-level info", async () => {
  const result = await collectOne(
    usageLines(turnContext("gpt-4o"), {
      type: "event_msg",
      payload: { type: "token_count", info: { last_token_usage: counts(1, 2, 3) } },
      info: { last_token_usage: counts(100, 200, 300) },
    }),
  );
  assert.deepEqual(result, [usage("gpt-4o", 1, 2, 3)]);
});

test("usage accepts an event_msg payload without a type", async () => {
  const result = await collectOne(
    usageLines(turnContext("gpt-4o"), { type: "event_msg", payload: { info: { last_token_usage: counts(7, 8, 9) } } }),
  );
  assert.deepEqual(result, [usage("gpt-4o", 7, 8, 9)]);
});

test("usage ignores event_msg payloads of other types", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("gpt-4o"),
      { type: "event_msg", payload: { type: "agent_message", info: { last_token_usage: counts(100, 100, 100) } } },
      tokenCount({ last_token_usage: counts(1, 2, 3) }),
    ),
  );
  assert.deepEqual(result, [usage("gpt-4o", 1, 2, 3)]);
});

test("usage ignores lines that are not event_msg or turn_context", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("gpt-4o"),
      { type: "response_item", payload: { info: { last_token_usage: counts(100, 100, 100) } } },
      { type: "session_meta", info: { last_token_usage: counts(100, 100, 100) } },
      tokenCount({ last_token_usage: counts(4, 5, 6) }),
    ),
  );
  assert.deepEqual(result, [usage("gpt-4o", 4, 5, 6)]);
});

test("usage skips token events with no model", async () => {
  const result = await collectOne(usageLines(tokenCount({ last_token_usage: counts(10, 10, 10) })));
  assert.deepEqual(result, []);
});

test("usage resolves the model from info.model, then model_name, then metadata.model, then turn_context", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("ctx-model"),
      tokenCount({ model: "m-info", model_name: "m-name", metadata: { model: "m-meta" }, last_token_usage: counts(1, 0, 0) }),
      tokenCount({ model_name: "m-name", metadata: { model: "m-meta" }, last_token_usage: counts(2, 0, 0) }),
      tokenCount({ metadata: { model: "m-meta" }, last_token_usage: counts(4, 0, 0) }),
      tokenCount({ last_token_usage: counts(8, 0, 0) }),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(result.map((u) => [u.model, u.input_tokens])),
    { "m-info": 1, "m-name": 2, "m-meta": 4, "ctx-model": 8 },
  );
});

test("usage keeps the previous model when a turn_context has none", async () => {
  const result = await collectOne(
    usageLines(turnContext("gpt-4o"), { type: "turn_context", payload: {} }, { type: "turn_context" }, tokenCount({ last_token_usage: counts(5, 0, 0) })),
  );
  assert.deepEqual(result, [usage("gpt-4o", 5, 0, 0)]);
});

test("usage creates a zero entry for a model whose token event has no counts", async () => {
  const result = await collectOne(usageLines(turnContext("gpt-4o"), tokenCount({ rate_limits: {} })));
  assert.deepEqual(result, [usage("gpt-4o", 0, 0, 0)]);
});

test("usage tracks the cumulative total separately for each model", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("a"),
      tokenCount({ total_token_usage: counts(100, 10, 0) }),
      turnContext("b"),
      tokenCount({ total_token_usage: counts(150, 15, 0) }),
      turnContext("a"),
      tokenCount({ total_token_usage: counts(180, 18, 0) }),
    ),
  );
  const byModel = Object.fromEntries(result.map((u) => [u.model, u]));
  assert.deepEqual(byModel.a, usage("a", 180, 18, 0));
  assert.deepEqual(byModel.b, usage("b", 150, 15, 0));
});

test("usage advances the running total with last_token_usage when no total is given", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("gpt-4o"),
      tokenCount({ last_token_usage: counts(10, 5, 1) }),
      tokenCount({ total_token_usage: counts(30, 15, 4) }),
    ),
  );
  assert.deepEqual(result, [usage("gpt-4o", 30, 15, 4)]);
});

test("usage resets the running total from total_token_usage when both are given", async () => {
  const result = await collectOne(
    usageLines(
      turnContext("gpt-4o"),
      tokenCount({ last_token_usage: counts(10, 5, 0), total_token_usage: counts(1000, 500, 0) }),
      tokenCount({ total_token_usage: counts(1100, 550, 0) }),
    ),
  );
  assert.deepEqual(result, [usage("gpt-4o", 110, 55, 0)]);
});

test("usage subtracts when a cumulative total goes down", async () => {
  const result = await collectOne(
    usageLines(turnContext("gpt-4o"), tokenCount({ total_token_usage: counts(100, 50, 10) }), tokenCount({ total_token_usage: counts(40, 20, 4) })),
  );
  assert.deepEqual(result, [usage("gpt-4o", 40, 20, 4)]);
});

test("usage treats missing and wrong-typed counts as zero", async () => {
  const result = await collectOne(
    usageLines(turnContext("gpt-4o"), tokenCount({ last_token_usage: { input_tokens: 5, output_tokens: "x", cached_input_tokens: null } })),
  );
  assert.deepEqual(result, [usage("gpt-4o", 5, 0, 0)]);
});

test("usage skips malformed lines", async () => {
  const content = [
    "not json",
    "",
    "[1,2]",
    "null",
    '{"type":"turn_context","payload":{"model":"gpt-4o"}}',
    "{broken",
    JSON.stringify(tokenCount({ last_token_usage: counts(3, 2, 1) })),
  ].join("\n");
  assert.deepEqual(await collectOne(content), [usage("gpt-4o", 3, 2, 1)]);
});

test("usage reports a session with no token events as an empty list", async () => {
  assert.deepEqual(await collectOne(usageLines(turnContext("gpt-4o"))), []);
});

test("usage omits a session whose mapping file is missing", async () => {
  const { codexBase, store } = usageSetup();
  assert.deepEqual(await collectUsage(store, codexBase, ["nonexistent-session"]), {});
});

test("usage omits a session whose mapping is empty", async () => {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "blank"), "\n");
  writeFile(join(codexBase, "sessions"), ".jsonl", usageLines(turnContext("m"), tokenCount({ last_token_usage: counts(1, 1, 1) })));
  assert.deepEqual(await collectUsage(store, codexBase, ["blank"]), {});
});

test("usage omits a session whose codex file is missing", async () => {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "s1"), "no-such-thread");
  assert.deepEqual(await collectUsage(store, codexBase, ["s1"]), {});
});

test("usage omits everything when the codex sessions directory does not exist", async () => {
  const mappingDir = freshDir("mapping");
  writeFileSync(join(mappingDir, "s1"), "thread-1");
  assert.deepEqual(await collectUsage(new SessionStore(mappingDir), join(scratch, "no-codex-home"), ["s1"]), {});
});

test("usage returns only the sessions that are found", async () => {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "found"), "thread-found");
  writeFileSync(join(mappingDir, "lost"), "thread-lost");
  writeFile(join(codexBase, "sessions", "2026", "05", "01"), "rollout-x-thread-found.jsonl", usageLines(turnContext("m"), tokenCount({ last_token_usage: counts(1, 2, 3) })));
  const result = await collectUsage(store, codexBase, ["found", "lost", "unmapped", "found"]);
  assert.deepEqual(result, { found: [usage("m", 1, 2, 3)] });
});

test("usage ignores session ids that are not plain file names", async () => {
  const { mappingDir, codexBase, store } = usageSetup();
  writeFileSync(join(mappingDir, "s1"), "thread-1");
  writeFile(join(codexBase, "sessions"), "thread-1.jsonl", usageLines(turnContext("m"), tokenCount({ last_token_usage: counts(1, 1, 1) })));
  assert.deepEqual(await collectUsage(store, codexBase, ["../mapping/s1", "", "a/b"]), {});
});

test("findCodexSessionFile prefers the flat file over a nested one", () => {
  const { codexBase } = usageSetup();
  const flat = writeFile(join(codexBase, "sessions"), "thread-9.jsonl", "{}\n");
  writeFile(join(codexBase, "sessions", "2026"), "rollout-thread-9.jsonl", "{}\n");
  assert.equal(findCodexSessionFile(codexBase, "thread-9"), flat);
});

test("findCodexSessionFile matches a nested file whose name contains the thread id", () => {
  const { codexBase } = usageSetup();
  const nested = writeFile(join(codexBase, "sessions", "2026", "04", "23"), "rollout-2026-04-23T01-02-03-thread-7.jsonl", "{}\n");
  writeFile(join(codexBase, "sessions", "2026", "04", "23"), "rollout-2026-04-23T01-02-03-thread-8.jsonl", "{}\n");
  assert.equal(findCodexSessionFile(codexBase, "thread-7"), nested);
});

test("findCodexSessionFile ignores files that are not jsonl", () => {
  const { codexBase } = usageSetup();
  writeFile(join(codexBase, "sessions"), "thread-5.txt", "{}\n");
  writeFile(join(codexBase, "sessions", "d"), "thread-5.jsonl.bak", "{}\n");
  assert.equal(findCodexSessionFile(codexBase, "thread-5"), undefined);
});

test("findCodexSessionFile takes the first match in directory order", () => {
  const { codexBase } = usageSetup();
  const first = writeFile(join(codexBase, "sessions", "2026", "04"), "rollout-a-thread-3.jsonl", "{}\n");
  writeFile(join(codexBase, "sessions", "2026", "05"), "rollout-a-thread-3.jsonl", "{}\n");
  writeFile(join(codexBase, "sessions", "2027"), "rollout-a-thread-3.jsonl", "{}\n");
  assert.equal(findCodexSessionFile(codexBase, "thread-3"), first);
});

test("findCodexSessionFile does not follow symlinked directories", () => {
  const { codexBase } = usageSetup();
  const outside = freshDir("outside");
  writeFile(outside, "rollout-thread-4.jsonl", "{}\n");
  symlinkSync(outside, join(codexBase, "sessions", "link"), "dir");
  assert.equal(findCodexSessionFile(codexBase, "thread-4"), undefined);
});
