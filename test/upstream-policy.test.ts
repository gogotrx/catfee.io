import { describe, expect, it } from "vitest";
import { isApprovedProxyPath } from "../src/grpc/upstream-policy.js";

describe("pinned java-tron upstream method policy", () => {
  it.each([
    "/protocol.Wallet/GetAccount",
    "/protocol.Wallet/GetNowBlock",
    "/protocol.Wallet/CreateTransaction2",
    "/protocol.Wallet/TriggerContract",
    "/protocol.Wallet/EstimateEnergy",
    "/protocol.WalletSolidity/GetNowBlock",
    "/protocol.WalletExtension/GetTransactionsFromThis2",
    "/protocol.Database/getBlockReference",
    "/protocol.Monitor/GetStatsInfo"
  ])("allows an audited query or unsigned transaction builder: %s", (path) => {
    expect(isApprovedProxyPath(path)).toBe(true);
  });

  it.each([
    "/protocol.Wallet/BroadcastTransaction",
    "/protocol.Wallet/EasyTransfer",
    "/protocol.Wallet/SendRawTransaction",
    "/protocol.Wallet/GetFutureData",
    "/protocol.Wallet/GetNowBlock/",
    "/protocol.Wallet//GetNowBlock",
    "/protocol.Wallet/GetNowBlock?x=1",
    "/protocol.Wallet/%47etNowBlock",
    "/Protocol.Wallet/GetNowBlock",
    undefined
  ])("rejects broadcast, unknown, or non-canonical paths: %s", (path) => {
    expect(isApprovedProxyPath(path)).toBe(false);
  });
});
