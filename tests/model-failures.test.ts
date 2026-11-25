// Model fallback must retain safe diagnostic reasons without copying prompts, credentials or stderr into replies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstAvailable } from "../plugins/command/model.ts";

test("exhausted candidates report safe reasons for each failure", async () => {
  await assert.rejects(
    firstAvailable("理解消息", ["missing", "invalid"], async (name) => {
      if (name === "missing") throw Object.assign(new Error("token=private-value"), { code: "ENOENT" });
      throw new SyntaxError("invalid private conversation contents");
    }),
    (error: Error) => {
      assert.match(error.message, /missing.*ENOENT/);
      assert.match(error.message, /invalid.*JSON/);
      assert.doesNotMatch(error.message, /private|token=/);
      return true;
    },
  );
});
