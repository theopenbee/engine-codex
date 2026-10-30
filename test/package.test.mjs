import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("manifest describes the codex engine", () => {
  assert.deepEqual(readJson("openbee.plugin.json"), {
    protocol_version: 1,
    type: "engine",
    id: "codex",
    name: { en: "Codex", zh: "Codex" },
    description: { en: "Runs tasks with OpenAI Codex", zh: "用 OpenAI Codex 执行任务" },
    command: ["node", "dist/index.js"],
    config: [
      {
        key: "path",
        type: "string",
        label: { en: "Codex path", zh: "Codex 路径" },
        help: { en: "Leave empty to use codex on PATH", zh: "留空则使用 PATH 里的 codex" },
      },
    ],
  });
});

test("package.json publishes dist and the manifest", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@theopenbee/engine-codex");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist", "openbee.plugin.json"]);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.equal(pkg.dependencies["@theopenbee/engine-sdk"], "file:../engine-sdk");
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
});

test("the build output exists", () => {
  assert.ok(existsSync(join(root, "dist", "index.js")));
  assert.ok(existsSync(join(root, "dist", "codex.js")));
});
