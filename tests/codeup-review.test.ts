// GitHub review format changes must not reject Codeup's nonempty findings or bypass its repair gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../plugins/codeup/runtime.ts";
import { project, type Settings } from "../plugins/codeup/settings.ts";

test("Codeup's reviewer accepts blocking findings in its own existing format", async () => {
  const folder = mkdtempSync(join(tmpdir(), "codeup-review-contract-"));
  try {
    const script = join(folder, "reviewer.cjs");
    const findings = [{ title: "src/save.ts:12", text: "Concurrent saves lose the accepted update." }];
    writeFileSync(
      script,
      `#!${process.execPath}\nconst fs=require('node:fs');let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{require('node:assert/strict').match(prompt,/findings/);fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({findings:${JSON.stringify(findings)}}));});`,
      { mode: 0o700 },
    );
    const shim = join(folder, "reviewer.cmd");
    if (process.platform === "win32") writeFileSync(shim, '@"%~dp0\\reviewer.cjs" %*');
    const p = project(
      JSON.parse(readFileSync(new URL("../examples/recipes/codeup/projects.json", import.meta.url), "utf8"))[0],
    );
    p.codex = process.platform === "win32" ? shim : script;
    const settings: Settings = {
      checks: [],
      sensitive: [],
      review: { model: "test", effort: "high", points: "Review actual defects" },
      autoMerge: false,
      protectedBranchVerified: true,
    };
    assert.deepEqual(await review(p, "A text diff", settings), findings);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
