import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  UPSTREAM_GRPC_URL: "http://127.0.0.1:50051",
  NODE_HTTP_URL: "http://127.0.0.1:8090",
  NODE_SOLIDITY_HTTP_URL: "http://127.0.0.1:8091",
  DATABASE_URL: "postgresql://localhost/seamless",
  ADMIN_TOKEN: "a".repeat(32),
  SIGNER_TOKEN: "b".repeat(32)
};

describe("gateway configuration", () => {
  it("starts safely in observe mode with resource sponsorship defaults", () => {
    const config = loadConfig(required);
    expect(config.mode).toBe("observe");
    expect(config.authEnforceInObserve).toBe(false);
    expect(config.sponsorEnergy).toBe(true);
    expect(config.allowedSelectors.has("a9059cbb")).toBe(true);
    expect(config.allowOwnerBandwidthBurn).toBe(false);
    expect(config.allowOwnerEnergyBurn).toBe(false);
    expect(config.kuaizuPackageThreshold).toBe(100_000);
  });

  it("requires a resource owner in sponsor mode", () => {
    expect(() => loadConfig({ ...required, GATEWAY_MODE: "sponsor" })).toThrow(/RESOURCE_OWNER_ADDRESS/);
  });

  it("allows provider-backed sponsorship without a resource wallet or signer", () => {
    const config = loadConfig({
      ...required,
      GATEWAY_MODE: "sponsor",
      ENERGY_SOURCE: "provider",
      SPONSOR_BANDWIDTH: "false",
      PROVIDER_MASTER_KEY: "c".repeat(64)
    });
    expect(config.energySource).toBe("provider");
    expect(config.resourceOwnerAddress).toBeUndefined();
    expect(config.maxOwnerBandwidthBurnSun).toBe(1_000_000n);
    expect(config.maxOwnerEnergyBurnSun).toBe(5_000_000n);
  });

  it("requires a 32-byte master key for encrypted provider credentials", () => {
    expect(() =>
      loadConfig({
        ...required,
        ENERGY_SOURCE: "provider",
        PROVIDER_MASTER_KEY: "too-short"
      })
    ).toThrow(/PROVIDER_MASTER_KEY/);
  });

  it.each([
    { AUTH_MODE: "none", expected: /AUTH_MODE/ },
    { INSUFFICIENT_POLICY: "forward", expected: /INSUFFICIENT_POLICY/ },
    { UNSUPPORTED_POLICY: "forward", expected: /UNSUPPORTED_POLICY/ },
    { ALLOW_OWNER_ENERGY_BURN: "true", expected: /ALLOW_OWNER_ENERGY_BURN/ },
    { SPONSOR_ENERGY: "false", expected: /SPONSOR_ENERGY/ },
    { SPONSOR_BANDWIDTH: "true", expected: /SPONSOR_BANDWIDTH/ }
  ])("rejects unsafe paid-provider sponsor settings", ({ expected, ...override }) => {
    expect(() =>
      loadConfig({
        ...required,
        GATEWAY_MODE: "sponsor",
        ENERGY_SOURCE: "provider",
        SPONSOR_BANDWIDTH: "false",
        PROVIDER_MASTER_KEY: "c".repeat(64),
        ...override
      })
    ).toThrow(expected);
  });

  it("accepts only canonical base64 provider master keys", () => {
    const canonical = Buffer.alloc(32, 7).toString("base64");
    expect(loadConfig({ ...required, ENERGY_SOURCE: "provider", PROVIDER_MASTER_KEY: canonical }).providerMasterKey)
      .toBe(canonical);
    expect(() =>
      loadConfig({ ...required, ENERGY_SOURCE: "provider", PROVIDER_MASTER_KEY: canonical.replace(/=$/, "") })
    ).toThrow(/PROVIDER_MASTER_KEY/);
  });

  it("rejects malformed function selectors", () => {
    expect(() => loadConfig({ ...required, ALLOWED_SELECTORS: "not-hex" })).toThrow(/ALLOWED_SELECTORS/);
  });

  it("validates the Kuaizu package threshold and owner burn limits", () => {
    expect(() => loadConfig({ ...required, KUAIZU_PACKAGE_THRESHOLD: "131001" }))
      .toThrow(/KUAIZU_PACKAGE_THRESHOLD/);
    expect(() => loadConfig({ ...required, MAX_OWNER_BANDWIDTH_BURN_SUN: "0" }))
      .toThrow(/MAX_OWNER_BANDWIDTH_BURN_SUN/);
    expect(() => loadConfig({ ...required, MAX_OWNER_ENERGY_BURN_SUN: "15000000001" }))
      .toThrow(/MAX_OWNER_ENERGY_BURN_SUN/);
  });
});
