import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const entry = join(root, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "engine-codex-e2e-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function findBun() {
  const probe = spawnSync("bun", ["-e", "console.log(process.execPath)"]);
  if (probe.status === 0) return probe.stdout.toString().trim();
  const runtime = join(homedir(), ".openbee", "runtime");
  if (!existsSync(runtime)) return null;
  for (const name of readdirSync(runtime)) {
    const candidate = join(runtime, name, "bun");
    if (name.startsWith("bun-") && existsSync(candidate)) return candidate;
  }
  return null;
}

const bun = findBun();
const runtimes = [
  { name: "node", command: process.execPath, skip: false },
  { name: "bun", command: bun, skip: bun ? false : "bun is not installed" },
];

const THREAD = "019d7293-0a51-71e0-b634-02183839d7b2";
const OTHER_THREAD = "019d7293-ffff-71e0-b634-000000000000";

const FAKE_CODEX = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const emit = (event) => fs.writeSync(1, JSON.stringify(event) + "\\n");
const fail = (text) => fs.writeSync(2, text);
if (args[0] === "--version") {
  fs.writeSync(1, (process.env.FAKE_CODEX_VERSION || "codex-cli 0.46.0") + "\\n");
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CODEX_RECORD) {
  fs.appendFileSync(
    process.env.FAKE_CODEX_RECORD,
    JSON.stringify({
      argv: args,
      cwd: process.cwd(),
      stdin,
      pid: process.pid,
      env: {
        OPENBEE_API_KEY: process.env.OPENBEE_API_KEY ?? null,
        BEE_TOKEN: process.env.BEE_TOKEN ?? null,
        NO_PROXY: process.env.NO_PROXY ?? null,
      },
    }) + "\\n",
  );
}
const thread = process.env.FAKE_CODEX_THREAD || ${JSON.stringify(THREAD)};
const message = (text) => emit({ type: "item.completed", item: { id: "item_x", type: "agent_message", text } });
const mode = process.env.FAKE_CODEX_MODE || "ok";
if (mode === "ok") {
  fail("a warning on stderr\\n");
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } });
  message("working on it");
  emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls", aggregated_output: "a\\n", exit_code: 0, status: "completed" } });
  message("final answer");
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
} else if (mode === "no-message") {
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "turn.completed", usage: {} });
} else if (mode === "no-thread") {
  message("answer without a thread");
} else if (mode === "two-threads") {
  emit({ type: "thread.started", thread_id: thread });
  emit({ type: "thread.started", thread_id: ${JSON.stringify(OTHER_THREAD)} });
  message("final answer");
} else if (mode === "error-exit") {
  emit({ type: "thread.started", thread_id: thread });
  message("partial answer");
  emit({ type: "error", message: "stream disconnected" });
  fail("ERROR: stream disconnected\\n");
  process.exit(1);
} else if (mode === "stderr-exit") {
  fail("first line\\n\\nboom\\n\\n  \\n");
  process.exit(2);
} else if (mode === "silent-exit") {
  process.exit(3);
} else if (mode === "resume-missing") {
  fail("Error: thread/resume: thread not found: " + args[2] + "\\n");
  process.exit(1);
} else if (mode === "signal") {
  emit({ type: "thread.started", thread_id: thread });
  process.kill(process.pid, "SIGKILL");
} else if (mode === "sleep") {
  emit({ type: "thread.started", thread_id: thread });
  setInterval(() => {}, 1000);
}
`;

const fakeCodex = join(scratch, "bin", "codex");
before(() => {
  mkdirSync(dirname(fakeCodex), { recursive: true });
  writeFileSync(fakeCodex, FAKE_CODEX);
  chmodSync(fakeCodex, 0o755);
});

let counter = 0;
function freshDir(prefix) {
  const dir = join(scratch, `${prefix}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkdirpSync(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseRequest(method, params, overrides = {}) {
  return {
    protocol_version: 1,
    method,
    openbee_version: "9.9.9",
    engine_id: "codex",
    language: "en",
    config: { path: fakeCodex },
    data_dir: freshDir("data"),
    state_dir: freshDir("state"),
    params,
    ...overrides,
  };
}

function pluginEnv(env) {
  const merged = { ...process.env, OPENBEE_API_KEY: "tok-secret", ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

function runPlugin(runtime, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [entry], { cwd: scratch, env: pluginEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input) + "\n");
  });
}

function response(res) {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${res.stdout}`);
  return JSON.parse(lines[0]);
}

function runParams(overrides = {}) {
  return {
    role: "worker",
    work_dir: freshDir("work"),
    prompt: "hello",
    session_id: "4d0ce91b-0856-44e2-b0d7-7765d824bba3",
    resume: false,
    extra_args: [],
    log_path: join(freshDir("logs"), "exec.log"),
    ...overrides,
  };
}

function recordedCalls(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function recordedCall(path) {
  const calls = recordedCalls(path);
  assert.equal(calls.length, 1, `expected exactly one codex call, got ${calls.length}`);
  return calls[0];
}

function mappingPath(req, sessionId = req.params.session_id) {
  return join(req.state_dir, "sessions", sessionId);
}

function writeMapping(req, threadId, sessionId = req.params.session_id) {
  mkdirSync(join(req.state_dir, "sessions"), { recursive: true });
  writeFileSync(mappingPath(req, sessionId), threadId);
}

const FIXED_ARGS = ["--json", "--dangerously-bypass-approvals-and-sandbox"];
const MCP = { name: "openbee", url: "http://127.0.0.1:12350/mcp", api_key_env: "OPENBEE_API_KEY" };
const MCP_ARGS = [
  "-c",
  'mcp_servers.openbee.url="http://127.0.0.1:12350/mcp"',
  "-c",
  'mcp_servers.openbee.bearer_token_env_var="OPENBEE_API_KEY"',
];

async function waitFor(predicate, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const runtime of runtimes) {
  const t = (name, fn, options = {}) => test(`[${runtime.name}] ${name}`, { skip: runtime.skip || options.skip }, fn);

  t("check returns the version and path", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {})));
    assert.deepEqual(res, { result: { version: "codex-cli 0.46.0", path: fakeCodex } });
  });

  t("check fails when the configured path does not exist", async () => {
    const missing = join(scratch, "no-such-codex");
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: missing } })));
    assert.deepEqual(res, { error: { message: `${missing} not found` } });
  });

  t("check fails with codex not found on PATH", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: {} }), { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "codex not found on PATH" } });
  });

  t("check uses codex from PATH when no path is configured", async () => {
    const res = response(await runPlugin(runtime, baseRequest("check", {}, { config: { path: "" } }), { PATH: dirname(fakeCodex) }));
    assert.deepEqual(res, { result: { version: "codex-cli 0.46.0", path: fakeCodex } });
  });

  t("run starts a new session with the prompt on stdin and returns the last agent message", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ prompt: "do the thing", extra_args: ["--model", "gpt-5"] }));
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["exec", "-", ...FIXED_ARGS, "--model", "gpt-5"]);
    assert.equal(call.stdin, "do the thing");
    assert.equal(call.cwd, realpathSync(req.params.work_dir));
  });

  t("run saves the thread id of a new session in the mapping file", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req));
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
    assert.deepEqual(readdirSync(join(req.state_dir, "sessions")), [req.params.session_id]);
  });

  t("run creates the sessions directory under a state directory that does not exist yet", async () => {
    const stateDir = join(freshDir("parent"), "nested", ".codex");
    const req = baseRequest("run", runParams(), { state_dir: stateDir });
    response(await runPlugin(runtime, req));
    assert.equal(readFileSync(join(stateDir, "sessions", req.params.session_id), "utf8"), THREAD);
  });

  t("run keeps the first thread id when the stream announces several", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req, { FAKE_CODEX_MODE: "two-threads" }));
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
  });

  t("run does not write a mapping when the stream has no thread id", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_MODE: "no-thread" }));
    assert.deepEqual(res, { result: { text: "answer without a thread" } });
    assert.ok(!existsSync(mappingPath(req)));
  });

  t("run overwrites an old mapping when a new session starts", async () => {
    const req = baseRequest("run", runParams());
    writeMapping(req, "old-thread");
    response(await runPlugin(runtime, req));
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
  });

  t("run resumes the thread from the mapping with the prompt as an argument", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "follow up", extra_args: ["--model", "gpt-5"] }));
    writeMapping(req, "mapped-thread-1");
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["exec", "resume", "mapped-thread-1", ...FIXED_ARGS, "follow up", "--model", "gpt-5"]);
    assert.equal(call.stdin, "");
  });

  t("run does not rewrite the mapping of a resumed session", async () => {
    const req = baseRequest("run", runParams({ resume: true }));
    writeMapping(req, "mapped-thread-1");
    response(await runPlugin(runtime, req, { FAKE_CODEX_THREAD: OTHER_THREAD }));
    assert.equal(readFileSync(mappingPath(req), "utf8"), "mapped-thread-1");
  });

  t("run resumes with a mapping that has a trailing newline", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "again" }));
    writeMapping(req, "mapped-thread-2\n");
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, ["exec", "resume", "mapped-thread-2", ...FIXED_ARGS, "again"]);
  });

  t("run passes a unicode prompt to a resumed session unchanged", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const prompt = "line one\n\"quoted\" 'single' `tick` $HOME \\n back\\slash \u{1F41D} 你好 <tag> & more";
    const req = baseRequest("run", runParams({ resume: true, prompt }));
    writeMapping(req, "mapped-thread-3");
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, ["exec", "resume", "mapped-thread-3", ...FIXED_ARGS, prompt]);
  });

  t("run starts a new session and warns when the mapping for a resume is missing", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "follow up" }));
    const raw = await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record });
    assert.deepEqual(response(raw), { result: { text: "final answer" } });
    assert.match(raw.stderr, /\[warn\] .*mapping not found.*4d0ce91b-0856-44e2-b0d7-7765d824bba3/);

    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["exec", "-", ...FIXED_ARGS]);
    assert.equal(call.stdin, "follow up");
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
  });

  t("run starts a new session when the mapping for a resume is empty", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true }));
    writeMapping(req, "");
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, ["exec", "-", ...FIXED_ARGS]);
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
  });

  t("run reports the codex error without retrying when the resumed thread no longer exists", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "follow up" }));
    writeMapping(req, "gone-thread");
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record, FAKE_CODEX_MODE: "resume-missing" }));
    assert.deepEqual(res, {
      result: { text: "", error: "codex exited with code 1: Error: thread/resume: thread not found: gone-thread" },
    });
    assert.deepEqual(recordedCall(record).argv.slice(0, 3), ["exec", "resume", "gone-thread"]);
    assert.equal(readFileSync(mappingPath(req), "utf8"), "gone-thread");
  });

  t("run works without a session id and writes no mapping", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ session_id: "" }));
    const raw = await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record });
    assert.deepEqual(response(raw), { result: { text: "final answer" } });
    assert.deepEqual(recordedCall(record).argv, ["exec", "-", ...FIXED_ARGS]);
    assert.deepEqual(readdirSync(join(req.state_dir, "sessions")), []);
  });

  t("run does not write outside the sessions directory for an unsafe session id", async () => {
    const stateDir = freshDir("state");
    const req = baseRequest("run", runParams({ session_id: "../escape" }), { state_dir: stateDir });
    const raw = await runPlugin(runtime, req);
    assert.deepEqual(response(raw), { result: { text: "final answer" } });
    assert.match(raw.stderr, /invalid session id/);
    assert.ok(!existsSync(join(stateDir, "escape")));
    assert.deepEqual(readdirSync(join(stateDir, "sessions")), []);
  });

  t("run saves the mapping as soon as the thread starts, while codex is still running", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams());
    const child = spawn(runtime.command, [entry], {
      cwd: scratch,
      env: pluginEnv({ FAKE_CODEX_RECORD: record, FAKE_CODEX_MODE: "sleep" }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(req) + "\n");
    const closed = new Promise((resolve) => child.on("close", resolve));
    try {
      await waitFor(() => existsSync(mappingPath(req)), "the mapping file");
      assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
      assert.ok(isAlive(recordedCall(record).pid));
    } finally {
      process.kill(-child.pid, "SIGKILL");
      await closed;
    }
  }, { skip: process.platform === "win32" });

  t("run keeps the mapping when codex fails after the thread started", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_MODE: "error-exit" }));
    assert.deepEqual(res, { result: { text: "partial answer", error: "codex exited with code 1: ERROR: stream disconnected" } });
    assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
  });

  t("run writes the codex output and stderr to the log", async () => {
    const req = baseRequest("run", runParams());
    response(await runPlugin(runtime, req));
    const log = readFileSync(req.params.log_path, "utf8");
    assert.ok(log.includes(`"type":"thread.started","thread_id":"${THREAD}"`));
    assert.ok(log.includes('"text":"final answer"'));
    assert.ok(log.includes("a warning on stderr"));
    assert.ok(log.endsWith("\n"));
  });

  t("run puts the MCP config before the extra args and keeps the key out of the arguments", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ extra_args: ["--model", "gpt-5"], mcp: MCP }));
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });

    const call = recordedCall(record);
    assert.deepEqual(call.argv, ["exec", "-", ...FIXED_ARGS, ...MCP_ARGS, "--model", "gpt-5"]);
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.ok(!JSON.stringify(call.argv).includes("tok-secret"));
  });

  t("run puts the MCP config after the prompt of a resumed session", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ resume: true, prompt: "follow up", extra_args: ["--model", "gpt-5"], mcp: MCP }));
    writeMapping(req, "mapped-thread-4");
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, [
      "exec",
      "resume",
      "mapped-thread-4",
      ...FIXED_ARGS,
      "follow up",
      ...MCP_ARGS,
      "--model",
      "gpt-5",
    ]);
  });

  t("run uses the MCP server name and key variable from the request", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ mcp: { name: "bee-mcp", url: "http://h:1/mcp", api_key_env: "BEE_TOKEN" } }));
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record, BEE_TOKEN: "other-secret" }));
    const call = recordedCall(record);
    assert.deepEqual(call.argv.slice(4), [
      "-c",
      'mcp_servers.bee-mcp.url="http://h:1/mcp"',
      "-c",
      'mcp_servers.bee-mcp.bearer_token_env_var="BEE_TOKEN"',
    ]);
    assert.equal(call.env.BEE_TOKEN, "other-secret");
    assert.ok(!JSON.stringify(call.argv).includes("other-secret"));
  });

  t("run TOML-quotes the MCP url like strconv.Quote", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const req = baseRequest("run", runParams({ mcp: { name: "openbee", url: 'http://h/mcp?q="a"&p=\\x', api_key_env: "OPENBEE_API_KEY" } }));
    response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.equal(recordedCall(record).argv[5], 'mcp_servers.openbee.url="http://h/mcp?q=\\"a\\"&p=\\\\x"');
  });

  t("run passes no MCP config when openbee has no MCP address", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(recordedCall(record).argv, ["exec", "-", ...FIXED_ARGS]);
  });

  t("run passes the environment through", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CODEX_RECORD: record, NO_PROXY: "127.0.0.1,example.com" }));
    const call = recordedCall(record);
    assert.equal(call.env.OPENBEE_API_KEY, "tok-secret");
    assert.equal(call.env.NO_PROXY, "127.0.0.1,example.com");
  });

  t("run delivers a multi-megabyte unicode prompt on stdin unchanged", async () => {
    const record = join(freshDir("rec"), "calls.jsonl");
    const prompt = `line one\n"quoted" 'single' \`tick\` $HOME \\n back\\slash\n${"emoji \u{1F41D} 你好 <tag> & more\n".repeat(150000)}end`;
    assert.ok(Buffer.byteLength(prompt) > 3 * 1024 * 1024);
    const req = baseRequest("run", runParams({ prompt }));
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_RECORD: record }));
    assert.deepEqual(res, { result: { text: "final answer" } });
    const call = recordedCall(record);
    assert.equal(call.stdin, prompt);
    assert.ok(!call.argv.includes(prompt));
  });

  t("run returns empty text and no error when codex says nothing", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CODEX_MODE: "no-message" }));
    assert.deepEqual(res, { result: { text: "" } });
  });

  t("run reports the exit code with the last non-empty stderr line", async () => {
    const req = baseRequest("run", runParams());
    const res = response(await runPlugin(runtime, req, { FAKE_CODEX_MODE: "stderr-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "codex exited with code 2: boom" } });
    assert.ok(readFileSync(req.params.log_path, "utf8").includes("boom"));
  });

  t("run reports only the exit code when codex exits non-zero silently", async () => {
    const res = response(await runPlugin(runtime, baseRequest("run", runParams()), { FAKE_CODEX_MODE: "silent-exit" }));
    assert.deepEqual(res, { result: { text: "", error: "codex exited with code 3" } });
  });

  t(
    "run reports the signal when codex is killed",
    async () => {
      const req = baseRequest("run", runParams());
      const res = response(await runPlugin(runtime, req, { FAKE_CODEX_MODE: "signal" }));
      assert.deepEqual(res, { result: { text: "", error: "codex was terminated by signal SIGKILL" } });
      assert.equal(readFileSync(mappingPath(req), "utf8"), THREAD);
    },
    { skip: process.platform === "win32" },
  );

  t("run fails when codex cannot be found", async () => {
    const req = baseRequest("run", runParams(), { config: {} });
    const res = response(await runPlugin(runtime, req, { PATH: freshDir("empty-path") }));
    assert.deepEqual(res, { error: { message: "codex not found on PATH" } });
  });

  t("run fails when the working directory does not exist", async () => {
    const req = baseRequest("run", runParams({ work_dir: join(scratch, "no-such-dir") }));
    const res = response(await runPlugin(runtime, req));
    assert.ok(res.error.message.startsWith("start codex: "), res.error.message);
  });

  t(
    "stopping the plugin's process group kills codex",
    async () => {
      const record = join(freshDir("rec"), "calls.jsonl");
      const req = baseRequest("run", runParams());
      const child = spawn(runtime.command, [entry], {
        cwd: scratch,
        env: pluginEnv({ FAKE_CODEX_RECORD: record, FAKE_CODEX_MODE: "sleep" }),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(req) + "\n");
      const closed = new Promise((resolve) => child.on("close", resolve));
      await waitFor(() => recordedCalls(record).length === 1, "codex to start");
      const codexPid = recordedCall(record).pid;
      assert.ok(isAlive(codexPid));
      process.kill(-child.pid, "SIGKILL");
      await closed;
      await waitFor(() => !isAlive(codexPid), "codex to exit");
    },
    { skip: process.platform === "win32" },
  );

  const rollout = (model, input, output, cached) =>
    [
      { type: "turn_context", payload: { model } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cached } } } },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n";

  t("usage reads sessions through the mapping and CODEX_HOME and omits missing ones", async () => {
    const codexHome = freshDir("codex-home");
    const nested = mkdirpSync(join(codexHome, "sessions", "2026", "04", "23"));
    writeFileSync(join(nested, "rollout-2026-04-23T01-02-03-thread-aaa.jsonl"), rollout("gpt-5", 100, 50, 20));
    writeFileSync(join(codexHome, "sessions", "thread-bbb.jsonl"), rollout("gpt-5-codex", 7, 8, 9));
    const req = baseRequest("usage", { session_ids: ["sess-a", "sess-b", "sess-lost", "sess-unmapped"] });
    writeMapping(req, "thread-aaa\n", "sess-a");
    writeMapping(req, "thread-bbb", "sess-b");
    writeMapping(req, "thread-lost", "sess-lost");
    const res = response(await runPlugin(runtime, req, { CODEX_HOME: codexHome }));
    assert.deepEqual(res, {
      result: {
        usage: {
          "sess-a": [{ model: "gpt-5", input_tokens: 100, output_tokens: 50, cache_creation_tokens: 0, cache_read_tokens: 20 }],
          "sess-b": [{ model: "gpt-5-codex", input_tokens: 7, output_tokens: 8, cache_creation_tokens: 0, cache_read_tokens: 9 }],
        },
      },
    });
  });

  t("usage falls back to ~/.codex", async () => {
    const home = freshDir("home");
    const nested = mkdirpSync(join(home, ".codex", "sessions", "2026", "05", "01"));
    writeFileSync(join(nested, "rollout-x-thread-home.jsonl"), rollout("gpt-5", 1, 2, 3));
    const req = baseRequest("usage", { session_ids: ["sess-home"] });
    writeMapping(req, "thread-home", "sess-home");
    const res = response(await runPlugin(runtime, req, { HOME: home, USERPROFILE: home, CODEX_HOME: undefined }));
    assert.deepEqual(res.result.usage, {
      "sess-home": [{ model: "gpt-5", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 3 }],
    });
  });

  t("usage finds the thread that a run just saved", async () => {
    const codexHome = freshDir("codex-home");
    writeFileSync(join(mkdirpSync(join(codexHome, "sessions")), `${THREAD}.jsonl`), rollout("gpt-5", 11, 12, 13));
    const state = freshDir("state");
    const params = runParams();
    response(await runPlugin(runtime, baseRequest("run", params, { state_dir: state })));
    const res = response(
      await runPlugin(runtime, baseRequest("usage", { session_ids: [params.session_id] }, { state_dir: state }), { CODEX_HOME: codexHome }),
    );
    assert.deepEqual(res.result.usage[params.session_id], [
      { model: "gpt-5", input_tokens: 11, output_tokens: 12, cache_creation_tokens: 0, cache_read_tokens: 13 },
    ]);
  });

  t("usage without any mapping directory returns an empty map", async () => {
    const req = baseRequest("usage", { session_ids: ["a", "b"] }, { state_dir: join(freshDir("parent"), "missing") });
    const res = response(await runPlugin(runtime, req, { CODEX_HOME: freshDir("codex-home") }));
    assert.deepEqual(res, { result: { usage: {} } });
  });

  t("usage with no session ids returns an empty map", async () => {
    const req = baseRequest("usage", { session_ids: [] });
    const res = response(await runPlugin(runtime, req, { CODEX_HOME: freshDir("codex-home") }));
    assert.deepEqual(res, { result: { usage: {} } });
  });
}
