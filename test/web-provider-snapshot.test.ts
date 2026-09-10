import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

function functionSource(script: string, start: string, end: string): string {
  const startIndex = script.indexOf(start);
  const endIndex = script.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return script.slice(startIndex, endIndex);
}

describe("management provider account snapshot UI", () => {
  it("queries snapshots only on demand and renders reference pricing with safe DOM APIs", async () => {
    const [html, script, styles] = await Promise.all([
      readFile(path.resolve("web/index.html"), "utf8"),
      readFile(path.resolve("web/app.js"), "utf8"),
      readFile(path.resolve("web/styles.css"), "utf8")
    ]);

    const querySource = functionSource(
      script,
      "async function queryProviderAccountSnapshot",
      "function normalizeProviderAccountSnapshot"
    );
    const renderSource = functionSource(
      script,
      "function createProviderAccountSnapshot",
      "async function queryProviderAccountSnapshot"
    );
    const refreshSource = functionSource(script, "async function refreshAll", "function renderStatus");

    expect(html).toContain("余额和参考价格仅在手动点击后查询，不会自动轮询");
    expect(script.match(/\/account-snapshot/g)).toHaveLength(1);
    expect(querySource).toContain("method: \"POST\"");
    expect(querySource).toContain("encodeURIComponent(providerId)");
    expect(querySource).toContain("providerSnapshotRequests.add(providerId)");
    expect(querySource).not.toContain("apiKey");
    expect(refreshSource).not.toContain("account-snapshot");

    expect(renderSource).toContain("查询余额/价格");
    expect(renderSource).toContain("参考单价");
    expect(renderSource).toContain("65,000 参考成本");
    expect(renderSource).toContain("131,000 参考成本");
    expect(renderSource).toContain("orderMoney");
    expect(renderSource).toContain("textContent");
    expect(renderSource).not.toContain("innerHTML");
    expect(styles).toContain(".provider-account-snapshot");
    expect(styles).toContain(".provider-snapshot-facts");
  });

  it("clears account snapshots and in-flight state when the admin session ends", async () => {
    const script = await readFile(path.resolve("web/app.js"), "utf8");
    const clearSource = functionSource(script, "function clearSessionState", "function showLogin");

    expect(clearSource).toContain("state.providerSnapshots.clear()");
    expect(clearSource).toContain("state.providerSnapshotErrors.clear()");
    expect(clearSource).toContain("state.providerSnapshotRequests.clear()");
  });
});
