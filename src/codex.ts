import { createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { cliVersion, findCli, log, spawnCli } from "@theopenbee/engine-sdk";
import type { Engine, EngineRequest, RunParams, RunResult, TokenUsage } from "@theopenbee/engine-sdk";

type JsonObject = Record<string, unknown>;
type McpParams = NonNullable<RunParams["mcp"]>;

interface Counts {
  input: number;
  output: number;
  cached: number;
}

interface SessionFile {
  name: string;
  path: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPlainFileName(id: unknown): id is string {
  return typeof id === "string" && id !== "" && id !== "." && id !== ".." && !/[\\/\0]/.test(id);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, "0");
}

const GO_SIMPLE_ESCAPES: Record<number, string> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
};

const GO_PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

function isGoPrintable(codePoint: number, char: string): boolean {
  return codePoint === 0x20 || (codePoint > 0x20 && GO_PRINTABLE.test(char));
}

export function goQuote(value: string): string {
  let out = '"';
  for (const original of value) {
    let codePoint = original.codePointAt(0) ?? 0xfffd;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
    const char = String.fromCodePoint(codePoint);
    if (char === '"' || char === "\\") {
      out += `\\${char}`;
    } else if (isGoPrintable(codePoint, char)) {
      out += char;
    } else if (GO_SIMPLE_ESCAPES[codePoint] !== undefined) {
      out += GO_SIMPLE_ESCAPES[codePoint];
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      out += `\\x${hex(codePoint, 2)}`;
    } else if (codePoint < 0x10000) {
      out += `\\u${hex(codePoint, 4)}`;
    } else {
      out += `\\U${hex(codePoint, 8)}`;
    }
  }
  return `${out}"`;
}

export function mcpArgs(mcp: McpParams | undefined): string[] {
  if (!mcp?.url) return [];
  const prefix = `mcp_servers.${mcp.name}.`;
  return ["-c", `${prefix}url=${goQuote(mcp.url)}`, "-c", `${prefix}bearer_token_env_var=${goQuote(mcp.api_key_env)}`];
}

export function buildArgs(threadId: string, resume: boolean, prompt: string, extraArgs: string[]): string[] {
  const base =
    resume && threadId !== ""
      ? ["exec", "resume", threadId, "--json", "--dangerously-bypass-approvals-and-sandbox"]
      : ["exec", "-", "--json", "--dangerously-bypass-approvals-and-sandbox"];
  if (resume && threadId !== "" && prompt !== "") base.push(prompt);
  return [...base, ...extraArgs];
}

export function threadIdFromLine(line: string): string {
  const text = line.trim();
  if (!text.startsWith("{")) return "";
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return "";
  }
  if (isObject(event) && event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
  return "";
}

export async function extractResultFromLog(logPath: string): Promise<string> {
  let lastText = "";
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      const text = raw.trim();
      if (!text.startsWith("{")) continue;
      let event: unknown;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isObject(event) || event.type !== "item.completed" || !isObject(event.item)) continue;
      const item = event.item;
      if (item.type === "agent_message" && typeof item.text === "string" && item.text !== "") lastText = item.text;
    }
  } catch {
    return lastText;
  } finally {
    lines.close();
    stream.destroy();
  }
  return lastText;
}

export class SessionStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get(sessionId: string): string | undefined {
    if (!isPlainFileName(sessionId)) return undefined;
    let data: string;
    try {
      data = readFileSync(join(this.dir, sessionId), "utf8");
    } catch {
      return undefined;
    }
    const threadId = data.trim();
    return threadId === "" ? undefined : threadId;
  }

  set(sessionId: string, threadId: string): void {
    if (!isPlainFileName(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
    const dest = join(this.dir, sessionId);
    const tmp = `${dest}.tmp`;
    try {
      writeFileSync(tmp, threadId);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new Error(`write temp session file: ${errorMessage(err)}`);
    }
    try {
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new Error(`rename session file: ${errorMessage(err)}`);
    }
  }
}

export function openSessionStore(dir: string): SessionStore {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`create sessions dir: ${errorMessage(err)}`);
  }
  return new SessionStore(dir);
}

export function codexBaseDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.CODEX_HOME || join(home, ".codex");
}

function listSessionFiles(dir: string, out: SessionFile[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (!isMissing(err)) log.warn(`reading ${dir} failed: ${errorMessage(err)}`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listSessionFiles(path, out);
    else if (entry.name.endsWith(".jsonl")) out.push({ name: entry.name, path });
  }
}

class SessionFiles {
  private readonly sessionsDir: string;
  private listing: SessionFile[] | undefined;

  constructor(codexBase: string) {
    this.sessionsDir = join(codexBase, "sessions");
  }

  find(threadId: string): string | undefined {
    if (!isPlainFileName(threadId)) return undefined;
    const flat = join(this.sessionsDir, `${threadId}.jsonl`);
    if (isFile(flat)) return flat;
    if (!this.listing) {
      this.listing = [];
      listSessionFiles(this.sessionsDir, this.listing);
    }
    return this.listing.find((file) => file.name.includes(threadId))?.path;
  }
}

export function findCodexSessionFile(codexBase: string, threadId: string): string | undefined {
  return new SessionFiles(codexBase).find(threadId);
}

function readCounts(value: unknown): Counts | undefined {
  if (!isObject(value)) return undefined;
  return {
    input: numberOrZero(value.input_tokens),
    output: numberOrZero(value.output_tokens),
    cached: numberOrZero(value.cached_input_tokens),
  };
}

function addCounts(target: TokenUsage, counts: Counts): void {
  target.input_tokens += counts.input;
  target.output_tokens += counts.output;
  target.cache_read_tokens += counts.cached;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveModel(info: JsonObject, currentModel: string): string {
  const metadata = isObject(info.metadata) ? info.metadata : {};
  return stringOrEmpty(info.model) || stringOrEmpty(info.model_name) || stringOrEmpty(metadata.model) || currentModel;
}

async function parseSessionFile(path: string): Promise<TokenUsage[]> {
  const totals = new Map<string, TokenUsage>();
  const previous = new Map<string, Counts>();
  let currentModel = "";
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject(event)) continue;
      const payload = isObject(event.payload) ? event.payload : {};
      if (event.type === "turn_context") {
        const model = stringOrEmpty(payload.model);
        if (model !== "") currentModel = model;
      } else if (event.type === "event_msg") {
        const payloadType = stringOrEmpty(payload.type);
        if (payloadType !== "" && payloadType !== "token_count") continue;
        const info = isObject(payload.info) ? payload.info : isObject(event.info) ? event.info : undefined;
        if (!info) continue;
        const model = resolveModel(info, currentModel);
        if (model === "") continue;
        let usage = totals.get(model);
        if (!usage) {
          usage = { model, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
          totals.set(model, usage);
        }
        const prev = previous.get(model) ?? { input: 0, output: 0, cached: 0 };
        previous.set(model, prev);
        const last = readCounts(info.last_token_usage);
        const total = readCounts(info.total_token_usage);
        if (last) {
          addCounts(usage, last);
          if (total) {
            previous.set(model, total);
          } else {
            prev.input += last.input;
            prev.output += last.output;
            prev.cached += last.cached;
          }
        } else if (total) {
          addCounts(usage, { input: total.input - prev.input, output: total.output - prev.output, cached: total.cached - prev.cached });
          previous.set(model, total);
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...totals.values()];
}

export async function collectUsage(store: SessionStore, codexBase: string, sessionIds: string[]): Promise<Record<string, TokenUsage[]>> {
  const files = new SessionFiles(codexBase);
  const found = new Map<string, TokenUsage[]>();
  for (const id of sessionIds) {
    if (found.has(id)) continue;
    const threadId = store.get(id);
    if (threadId === undefined) continue;
    const path = files.find(threadId);
    if (!path) continue;
    try {
      found.set(id, await parseSessionFile(path));
    } catch (err) {
      log.warn(`reading codex session file for ${id} failed: ${errorMessage(err)}`);
    }
  }
  return Object.fromEntries(found);
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return "";
}

export function failureText(code: number | null, signal: NodeJS.Signals | null, stderrTail: string): string {
  const base = code === null ? `codex was terminated by signal ${signal ?? "unknown"}` : `codex exited with code ${code}`;
  const detail = lastNonEmptyLine(stderrTail);
  return detail === "" ? base : `${base}: ${detail}`;
}

function resolveThread(store: SessionStore, sessionId: string, resume: boolean): { threadId: string; resume: boolean } {
  if (!resume) return { threadId: "", resume: false };
  const threadId = store.get(sessionId);
  if (threadId === undefined) {
    log.warn(`codex session mapping not found for ${JSON.stringify(sessionId)}, starting a new session`);
    return { threadId: "", resume: false };
  }
  return { threadId, resume: true };
}

export const engine: Engine = {
  async check(req) {
    const path = findCli(req.config, "codex");
    return { version: await cliVersion(path), path };
  },

  async run(req: EngineRequest<RunParams>): Promise<RunResult> {
    const params = req.params;
    const command = findCli(req.config, "codex");
    const store = openSessionStore(join(req.state_dir, "sessions"));
    const thread = resolveThread(store, params.session_id, params.resume);
    const args = buildArgs(thread.threadId, thread.resume, params.prompt, [...mcpArgs(params.mcp), ...(params.extra_args ?? [])]);

    let awaitingThread = !thread.resume;
    let outcome;
    try {
      outcome = await spawnCli({
        command,
        args,
        cwd: params.work_dir,
        input: thread.resume ? undefined : params.prompt,
        logPath: params.log_path,
        onStdoutLine(line) {
          if (awaitingThread) {
            const threadId = threadIdFromLine(line);
            if (threadId !== "") {
              awaitingThread = false;
              try {
                store.set(params.session_id, threadId);
              } catch (err) {
                log.error(`store codex session ${JSON.stringify(params.session_id)} failed: ${errorMessage(err)}`);
              }
            }
          }
          return line;
        },
      });
    } catch (err) {
      throw new Error(`start codex: ${errorMessage(err)}`);
    }

    const text = await extractResultFromLog(params.log_path);
    if (outcome.code !== 0) return { text, error: failureText(outcome.code, outcome.signal, outcome.stderrTail) };
    return { text };
  },

  async usage(req) {
    return collectUsage(new SessionStore(join(req.state_dir, "sessions")), codexBaseDir(), req.params.session_ids ?? []);
  },
};
