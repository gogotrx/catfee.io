import { describe, expect, it } from "vitest";
import { validateResourceTransaction } from "../src/signer-server.js";

const OWNER = "TEtcDUeVostxm9cy6k8vnpdavKe4SrmTxL";
const RECEIVER = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    txID: "00".repeat(32),
    raw_data_hex: "00",
    visible: true,
    raw_data: {
      expiration: Date.now() + 60_000,
      contract: [
        {
          type: "DelegateResourceContract",
          parameter: {
            value: {
              owner_address: OWNER,
              receiver_address: RECEIVER,
              resource: "ENERGY",
              balance: 1_000_000,
              ...overrides
            }
          }
        }
      ]
    }
  };
}

describe("signer policy", () => {
  it("accepts an unlocked resource delegation within the cap", () => {
    expect(() => validateResourceTransaction(transaction(), OWNER, 2_000_000n)).not.toThrow();
  });

  it("rejects locked delegation", () => {
    expect(() => validateResourceTransaction(transaction({ lock: true }), OWNER, 2_000_000n)).toThrow(/Locked/);
  });

  it("rejects a delegation above the signer cap", () => {
    expect(() => validateResourceTransaction(transaction({ balance: 3_000_000 }), OWNER, 2_000_000n)).toThrow(
      /exceeds signer policy/
    );
  });

  it("rejects a different owner", () => {
    expect(() => validateResourceTransaction(transaction({ owner_address: RECEIVER }), OWNER, 2_000_000n)).toThrow(
      /does not match/
    );
  });
});
