// Guard against losing project settings in a worktree or handing a development database to migration tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developmentEnv, runMysqlMigration } from "../plugins/codeup/local-env.ts";
import { execute } from "../plugins/codeup/runtime.ts";

test("only registered settings reach the worktree child and its parent stays unchanged", async () => {
  const folder = mkdtempSync(join(tmpdir(), "codeup-env-"));
  try {
    const file = join(folder, ".env");
    writeFileSync(file, 'APP_LABEL="two words"\nUNLISTED_SETTING=private\n');
    const original = process.env.APP_LABEL;
    const env = developmentEnv({ file, keys: ["APP_LABEL"] });
    const output = await execute(
      [process.execPath, "-p", "JSON.stringify([process.env.APP_LABEL,process.env.UNLISTED_SETTING])"],
      folder,
      undefined,
      undefined,
      env,
    );
    assert.equal(process.env.APP_LABEL, original);
    assert.deepEqual(JSON.parse(output), ["two words", null]);
    assert.throws(() => developmentEnv({ file, keys: ["ABSENT_SETTING"] }), /ABSENT_SETTING/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test(
  "migration command cannot fall back to the application database when MySQL cannot start",
  { skip: process.platform === "win32" },
  async () => {
    const folder = mkdtempSync(join(tmpdir(), "codeup-migration-"));
    try {
      const marker = join(folder, "migration-ran");
      await assert.rejects(
        runMysqlMigration(
          {
            binDir: folder,
            database: "test_app",
            command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'yes')", marker],
          },
          folder,
        ),
      );
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
