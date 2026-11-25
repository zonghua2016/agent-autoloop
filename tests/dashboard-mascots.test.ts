// Command-backed jobs and idle snapshots must not replace the approved coding-station mascot.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("the coding station keeps Codex when a command-backed job finishes and the station becomes idle", async (t) => {
  const root = new URL("../examples/recipes/live-dashboard/public/", import.meta.url);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "three") return nextResolve(new URL("vendor/three.module.js", root).href, context);
      if (specifier.startsWith("three/addons/"))
        return nextResolve(new URL("vendor/" + specifier.slice(6), root).href, context);
      return nextResolve(specifier, context);
    },
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) }),
      }),
    },
  });
  t.after(() => {
    hooks.deregister();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const { Scene } = await import(new URL("vendor/three.module.js", root).href);
  const { createArchitecture } = await import(new URL("models.js", root).href);
  const scene = new Scene();
  const architecture = createArchitecture(scene);
  architecture.update(0, 0, new Set(["coder"]), { coder: { brand: "codex", active: true } }, true);
  const codex = scene.getObjectByName("codex");
  assert.ok(codex?.visible);
  for (const role of [
    { brand: "robot", name: "Bug 表修复与检查", active: true },
    { brand: "robot", name: "Bug 表修复与检查", active: false, previous: true },
    { brand: null, active: false },
  ]) {
    architecture.update(0, 1, new Set(role.active ? ["coder"] : []), { coder: role }, true);
    assert.equal(codex.visible, true, "task changes must retain the same Codex model");
    assert.equal(scene.getObjectByName("robot"), undefined);
  }
});
