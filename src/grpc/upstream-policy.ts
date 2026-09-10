// Exact proxy surface audited against java-tron GreatVoyage-v4.8.2.1,
// commit f8b05d40, protocol/src/main/protos/api/api.proto. Any node upgrade
// must update this list deliberately; new RPCs fail closed by default.
const METHODS_BY_SERVICE = {
  Wallet: `
    GetAccount GetAccountById GetAccountBalance GetBlockBalanceTrace
    CreateTransaction CreateTransaction2 UpdateAccount SetAccountId UpdateAccount2
    VoteWitnessAccount UpdateSetting UpdateEnergyLimit VoteWitnessAccount2
    CreateAssetIssue CreateAssetIssue2 UpdateWitness UpdateWitness2
    CreateAccount CreateAccount2 CreateWitness CreateWitness2 TransferAsset TransferAsset2
    ParticipateAssetIssue ParticipateAssetIssue2 FreezeBalance FreezeBalance2 FreezeBalanceV2
    UnfreezeBalance UnfreezeBalance2 UnfreezeBalanceV2 UnfreezeAsset UnfreezeAsset2
    WithdrawBalance WithdrawBalance2 WithdrawExpireUnfreeze DelegateResource UnDelegateResource
    CancelAllUnfreezeV2 UpdateAsset UpdateAsset2 ProposalCreate ProposalApprove ProposalDelete
    BuyStorage BuyStorageBytes SellStorage ExchangeCreate ExchangeInject ExchangeWithdraw
    ExchangeTransaction MarketSellAsset MarketCancelOrder GetMarketOrderById
    GetMarketOrderByAccount GetMarketPriceByPair GetMarketOrderListByPair GetMarketPairList
    ListNodes GetAssetIssueByAccount GetAccountNet GetAccountResource GetAssetIssueByName
    GetAssetIssueListByName GetAssetIssueById GetNowBlock GetNowBlock2 GetBlockByNum
    GetBlockByNum2 GetTransactionCountByBlockNum GetBlockById GetBlockByLimitNext
    GetBlockByLimitNext2 GetBlockByLatestNum GetBlockByLatestNum2 GetTransactionById
    DeployContract GetContract GetContractInfo TriggerContract TriggerConstantContract
    EstimateEnergy ClearContractABI ListWitnesses GetPaginatedNowWitnessList
    GetDelegatedResource GetDelegatedResourceV2 GetDelegatedResourceAccountIndex
    GetDelegatedResourceAccountIndexV2 GetCanDelegatedMaxSize GetAvailableUnfreezeCount
    GetCanWithdrawUnfreezeAmount ListProposals GetPaginatedProposalList GetProposalById
    ListExchanges GetPaginatedExchangeList GetExchangeById GetChainParameters
    GetAssetIssueList GetPaginatedAssetIssueList TotalTransaction GetNextMaintenanceTime
    GetTransactionInfoById AccountPermissionUpdate GetTransactionSignWeight
    GetTransactionApprovedList GetNodeInfo GetRewardInfo GetBrokerageInfo UpdateBrokerage
    CreateShieldedTransaction GetMerkleTreeVoucherInfo ScanNoteByIvk ScanAndMarkNoteByIvk
    ScanNoteByOvk GetSpendingKey GetExpandedSpendingKey GetAkFromAsk GetNkFromNsk
    GetIncomingViewingKey GetDiversifier GetNewShieldedAddress GetZenPaymentAddress GetRcm
    IsSpend CreateShieldedTransactionWithoutSpendAuthSig GetShieldTransactionHash
    CreateSpendAuthSig CreateShieldNullifier CreateShieldedContractParameters
    CreateShieldedContractParametersWithoutAsk ScanShieldedTRC20NotesByIvk
    ScanShieldedTRC20NotesByOvk IsShieldedTRC20ContractNoteSpent
    GetTriggerInputForShieldedTRC20Contract CreateCommonTransaction
    GetTransactionInfoByBlockNum GetBurnTrx GetTransactionFromPending
    GetTransactionListFromPending GetPendingSize GetBlock GetBandwidthPrices GetEnergyPrices
    GetMemoFee
  `,
  WalletSolidity: `
    GetAccount GetAccountById ListWitnesses GetPaginatedNowWitnessList GetAssetIssueList
    GetPaginatedAssetIssueList GetAssetIssueByName GetAssetIssueListByName GetAssetIssueById
    GetNowBlock GetNowBlock2 GetBlockByNum GetBlockByNum2 GetTransactionCountByBlockNum
    GetDelegatedResource GetDelegatedResourceV2 GetDelegatedResourceAccountIndex
    GetDelegatedResourceAccountIndexV2 GetCanDelegatedMaxSize GetAvailableUnfreezeCount
    GetCanWithdrawUnfreezeAmount GetExchangeById ListExchanges GetTransactionById
    GetTransactionInfoById GetMerkleTreeVoucherInfo ScanNoteByIvk ScanAndMarkNoteByIvk
    ScanNoteByOvk IsSpend ScanShieldedTRC20NotesByIvk ScanShieldedTRC20NotesByOvk
    IsShieldedTRC20ContractNoteSpent GetRewardInfo GetBrokerageInfo TriggerConstantContract
    EstimateEnergy GetTransactionInfoByBlockNum GetMarketOrderById GetMarketOrderByAccount
    GetMarketPriceByPair GetMarketOrderListByPair GetMarketPairList GetBurnTrx GetBlock
    GetBandwidthPrices GetEnergyPrices
  `,
  WalletExtension: `
    GetTransactionsFromThis GetTransactionsFromThis2 GetTransactionsToThis GetTransactionsToThis2
  `,
  Database: `getBlockReference GetDynamicProperties GetNowBlock GetBlockByNum`,
  Monitor: `GetStatsInfo`
} as const;

const APPROVED_PROXY_PATHS = new Set(
  Object.entries(METHODS_BY_SERVICE).flatMap(([service, methods]) =>
    methods.trim().split(/\s+/).map((method) => `/protocol.${service}/${method}`)
  )
);

export function isApprovedProxyPath(path: string | undefined): boolean {
  return path !== undefined && APPROVED_PROXY_PATHS.has(path);
}

