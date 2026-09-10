import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("management resource audit UI", () => {
  it("renders estimate, bandwidth funding, and solidified execution diagnostics", async () => {
    const [html, script] = await Promise.all([
      readFile(path.resolve("web/index.html"), "utf8"),
      readFile(path.resolve("web/app.js"), "utf8")
    ]);

    expect(html).toContain("能量预估");
    expect(html).toContain("带宽预检");
    expect(html).toContain("链上实绩");
    expect(script).toContain("energyEstimateRaw");
    expect(script).toContain("energyEstimateSafe");
    expect(script).toContain("estimatedBandwidthBurnSun");
    expect(script).toContain("receiptEnergyUsageTotal");
    expect(script).toContain("receiptEnergyFeeSun");
    expect(script).toContain("receiptResult");
    expect(script).toContain("energyPackageQuoted");
    expect(script).toContain("energyPackageAttempted");
    expect(script).toContain("minimumFeeLimitSun");
    expect(script).toContain("maximumFeeLimitSun");
    expect(script).toContain('Object.hasOwn(order, "orderedAmount")');
    expect(script).toContain("供应商余额");
    expect(script).toContain("代理交易待定");
    expect(`${html}\n${script}`).toContain("65,000 / 131,000");
    expect(`${html}\n${script}`).not.toMatch(/65,000\s*\/\s*130,000/);
  });
});
