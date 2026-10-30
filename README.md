# openbee Codex engine

An [openbee](https://github.com/theopenbee/openbee) engine plugin that runs tasks with [OpenAI Codex](https://www.npmjs.com/package/@openai/codex). It is built on [`@theopenbee/engine-sdk`](https://www.npmjs.com/package/@theopenbee/engine-sdk).

## Requirements

You install Codex and log in to it yourself. The plugin only starts it.

```sh
npm i -g @openai/codex
codex login
```

Codex is started with openbee's environment, including the variables set in openbee's **Env** settings.

The plugin itself needs Node.js 20 or newer (or Bun).

## Install

```sh
openbee plugin install codex
```

Or from npm by package name:

```sh
openbee plugin install @theopenbee/engine-codex
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/engine-codex.git
cd engine-codex
npm install
openbee plugin install "$(pwd)"
```

Then enable the plugin, and pick `codex` as the default engine or per worker.

## Settings

| Setting | Description |
|---|---|
| `path` | Path to the `codex` executable. Leave empty to use `codex` from `PATH`. |

The plugin checks the setting when it is enabled: it runs `codex --version` and shows the version, or the reason it failed (for example `codex not found on PATH`).

## Sessions

Codex names its conversations (threads) itself, so the plugin keeps a small mapping from each openbee session id to the Codex thread id. The mapping files live in `~/.openbee/.codex/sessions/`, one file per session, holding only the thread id. openbee never deletes this directory, so conversations survive uninstalling the plugin and conversations that were started before the plugin was installed keep working.

The mapping is written as soon as Codex announces the thread, so a run that is stopped or fails halfway can still be resumed. If a mapping is missing when a conversation should resume, the plugin logs a warning and starts a new Codex thread. If a mapping exists but Codex no longer has that thread, the run fails with Codex's own message; the plugin does not retry.

Token usage is read from Codex's own session files, `~/.codex/sessions/` (or `$CODEX_HOME/sessions/` when `CODEX_HOME` is set in openbee's environment), found through the mapping, and summed per model.

## How it runs Codex

New conversation, with the prompt on standard input:

```
codex exec - --json --dangerously-bypass-approvals-and-sandbox [mcp -c options] [extra args]
```

Later turns, with the prompt as the last argument:

```
codex exec resume <thread id> --json --dangerously-bypass-approvals-and-sandbox <prompt> [mcp -c options] [extra args]
```

- When openbee provides its MCP server, the plugin adds `-c mcp_servers.<name>.url="<url>"` and `-c mcp_servers.<name>.bearer_token_env_var="<key variable>"`. Codex reads the API key from its environment, so the key never appears on the command line.
- The result is the text of the last `agent_message` item Codex completed. A non-zero exit code is reported as a failed run (`codex exited with code N`), followed by the last line Codex wrote to standard error when there is one.
- Codex's output is written to the run's log file as it arrives.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The end-to-end tests run the plugin against a fake `codex` script, under Node and under Bun when it is installed (`bun` on `PATH` or `~/.openbee/runtime/bun-*/bun`).

## License

MIT
