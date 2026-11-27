// Tracks must clear the entry platform; hidden labels must retain their collision bounds.
import assert from "node:assert/strict";
import { test } from "node:test";

test("the thinking-to-card belt leaves room for its full width beside the entry platform", async () => {
  const root = new URL("../examples/recipes/live-dashboard/public/", import.meta.url);
  const { stations, routes } = await import(new URL("layout.js", root).href);
  const { CatmullRomCurve3, Vector3 } = await import(new URL("vendor/three.module.js", root).href);
  const entry = stations.find((station: { id: string }) => station.id === "intake");
  const curve = new CatmullRomCurve3(
    routes.thinkCard.map(([x, z, y = 0]: number[]) => new Vector3(x, y, z)),
    false,
    "centripetal",
    0.4,
  );
  for (const point of curve.getSpacedPoints(600)) {
    assert.ok(
      Math.hypot(point.x - entry.at[0], point.z - entry.at[2]) > entry.radius + 0.8,
      "the complete 1.6-wide track foundation must clear the entry platform",
    );
  }
});

test("hiding a crowded label retains the visible bounds used to avoid its neighbours", async () => {
  const path = new URL("../examples/recipes/live-dashboard/public/label-layout.js", import.meta.url);
  const { rememberLabelSizes } = await import(path.href);
  const target = {},
    sizes = new WeakMap();
  rememberLabelSizes([{ target, contentRect: { width: 120, height: 28 } }], sizes);
  rememberLabelSizes([{ target, contentRect: { width: 0, height: 0 } }], sizes);
  assert.deepEqual(sizes.get(target), [120, 28]);
});
