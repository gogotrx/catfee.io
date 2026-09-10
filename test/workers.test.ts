import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { TronNodeApi } from "../src/node-api.js";
import type { GatewayRepository } from "../src/repository.js";
import type { ResourceService } from "../src/resource-service.js";
import { startWorkers } from "../src/workers.js";

describe("confirmation worker resource audit", () => {
  it("passes the exact solidified receipt to atomic request finalization", async () => {
    const txId = "e".repeat(64);
    const receipt = {
      id: txId,
      fee: 345_000,
      result: "SUCCESS",
      receipt: {
        energy_usage_total: 64_321,
        energy_usage: 64_321,
        origin_energy_usage: 0,
        net_usage: 0,
        net_fee: 345_000,
        energy_fee: 0
      }
    };
    const markFinalized = vi.fn().mockResolvedValue(undefined);
    const repository = {
      releaseTerminalAddressClaims: vi.fn().mockResolvedValue(0),
      listStaleRequests: vi.fn().mockResolvedValue([]),
      listRequestsAwaitingFinality: vi.fn().mockResolvedValue([
        { txId, expirationMs: BigInt(Date.now() + 60_000) }
      ]),
      markFinalized,
      listReleaseBroadcasts: vi.fn().mockResolvedValue([]),
      listLeasesReadyToRelease: vi.fn().mockResolvedValue([])
    } as unknown as GatewayRepository;
    const node = {
      getSolidifiedReceipt: vi.fn().mockResolvedValue(receipt)
    } as unknown as TronNodeApi;
    const config = {
      mode: "sponsor",
      reclaimDelayMs: 30_000,
      confirmationIntervalMs: 60_000,
      reclaimIntervalMs: 60_000
    } as AppConfig;

    const controller = startWorkers(config, repository, node, {} as ResourceService);
    try {
      await vi.waitFor(() => {
        expect(markFinalized).toHaveBeenCalledWith(txId, true, 30_000, receipt);
      });
    } finally {
      controller.stop();
    }
  });
});
