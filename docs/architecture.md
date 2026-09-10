# 架构与交易时序

本项目是 TronLink 可使用的 plaintext gRPC 自定义节点网关。它不是修改钱包签名，也不是代用户发起 TRC20 交易。

当前 `{GATEWAY_IP}` 按 `GATEWAY_MODE=sponsor`、`ENERGY_SOURCE=provider` 部署。供应商、绑定地址和剩余次数均为可变运行状态，应以管理页为准；启用供应商并保留有效地址额度后，新广播可能产生真实付费订单。

```text
TronLink App
  │  gRPC :50051（用户本地签名后的原始交易）
  ▼
Seamless Gateway ───────────────► 自建 java-tron gRPC :50051
  │                                      │
  ├─ PostgreSQL：地址、次数、幂等、租约       ├─ HTTP :8090（估算/委托/广播/查询）
  │                                      └─ Solidity HTTP :8091（最终确认）
  │
  ├─ ENERGY_SOURCE=self ──► Loopback Signer :8787
  │                          └─ 只签资源钱包的 DelegateResource / UnDelegateResource
  │
  └─ ENERGY_SOURCE=provider ──HTTPS──► 能量供应商适配器
                                      ├─ 快租租用接口 https://api.kuaizu.io/api/rent
                                      └─ 快租只读账户接口 https://api.kuaizu.io/api/balance
```

`BroadcastTransaction` 的 sponsor 模式时序：

1. 从 protobuf 原始字段计算 `txID`，恢复签名地址并与 `owner_address` 比较。
2. 检查绑定、剩余次数、到期时间、合约地址和函数选择器。
3. 调用 `/wallet/estimateenergy`，保留原始估算与安全估算，并按签名交易字节数计算 Bandwidth。
4. 只准备资源缺口：自有资源模式执行 ENERGY/BANDWIDTH 委托；供应商模式为 ENERGY 创建幂等租用订单，并等待资源实际到账。
5. 不改变用户交易的任何字节，原样转发到 java-tron。
6. 自有资源路径在 java-tron 接受用户广播后计数，明确拒绝会释放预留次数。外部付费路径在供应商 `ACCEPTED`、`UNKNOWN` 或可能已经扣费时即消费次数，即使原交易没有广播或随后失败也不回退；只有所有供应商明确拒绝才释放。
7. SolidityNode 确认原交易后，自有资源租约异步取消委托并归还资源池；外部供应商订单按供应商租期自然结束。

同一 `txID` 只创建一条请求。重复广播返回已缓存的 java-tron 响应，不会重复扣次数。

## 外部供应商模式

外部供应商是 ENERGY 的另一条准备路径，不代替交易校验、绑定次数或自建节点。流程如下：

1. 网关完成签名、链上 owner permission、TAPOS、地址、白名单、memo 和次数校验，并使用自建节点估算实际 ENERGY 缺口。
2. PostgreSQL 以用户交易 `txID` 创建唯一供应商订单；多次提交同一交易不会创建第二张订单。同一 owner 地址还持有独占在途闸门，地址锁或该地址的 `ORDERING/ACCEPTED/UNKNOWN` 订单未解除前，第二笔交易会在预留次数和供应商外呼前拒绝。
3. 在供应商外呼前，PostgreSQL 使用事务级 advisory lock 原子核对全局预算和候选供应商自己的单笔 ENERGY、UTC 当日订单数、当日 ENERGY 总量，再按 `priority` 从小到大选择启用的供应商；先触达任一上限即拒绝。每个供应商的配置、加密凭据、预算用量、订单和尝试记录均由 `providerId` 隔离。
4. 只有被选中的供应商凭据会在内存中解密。当前快租适配器只向固定的 `https://api.kuaizu.io/api/rent` 发送租用请求，不接受数据库或管理页面提供的 URL。管理员也可手动调用本机 `POST /v1/providers/:id/account-snapshot`；后端用同一份加密凭据请求固定的 `/api/balance`，仅返回余额、参考单价、套餐参考成本和查询时间，不触碰订单或预算状态。
5. 快租明确拒绝时可以继续尝试下一家已配置供应商；只有所有供应商都明确拒绝才归还该地址的预留次数。网络超时、HTTP 结果不明确或响应无法验证时则立即把订单置为 `UNKNOWN`、消费次数并停止，不自动重试或切换供应商。
6. 供应商接受订单后，网关轮询自建节点账户资源。只有可用 ENERGY 达到 15% 安全总量才把订单置为 `FULFILLED`；紧邻广播前再查询一次，任何查询失败或安全缺口都会停止广播。provider 生产模式不允许用用户 TRX 补 ENERGY；`fee_limit` 仍必须覆盖安全总 ENERGY且不超过链上上限。
7. 超过确认窗口仍未看见 ENERGY 时停止广播并进入人工核对流程，不创建第二张租用订单。

订单状态为 `PENDING → ORDERING → ACCEPTED → FULFILLED`，明确业务拒绝为 `REJECTED`，结果不确定为 `UNKNOWN`。`UNKNOWN` 不是“失败且可以重试”，它表示供应商可能已经收单或扣费，必须先查供应商订单和链上资源。

预算窗口为 UTC 自然日。`ORDERING`、`ACCEPTED`、`FULFILLED`、`UNKNOWN` 同时占用全局与对应供应商的订单数和 ENERGY 额度，明确 `REJECTED` 才释放。当前全局上限由环境变量配置并在页面只读显示；快租只支持 65,000/131,000 两档，单笔上限默认且最高为 131,000。先按原始 `estimateenergy` 选档：低于可配置阈值（默认 100,000）选择 65,000，否则选择 131,000；当 65,000 无法覆盖安全缺口时强制升级到 131,000，131,000 仍不足则拒绝。预算按实际套餐量计算。其他供应商通过各自适配器声明套餐规则，不与快租数据混用。`/v1/status` 的 `energyProviders.budget.providers[]` 返回每家的已用与剩余额度。

`GATEWAY_MODE=sponsor + ENERGY_SOURCE=provider` 必须设置 `SPONSOR_BANDWIDTH=false`、`ALLOW_OWNER_ENERGY_BURN=false`、`AUTH_MODE=bound_address`、`INSUFFICIENT_POLICY=reject` 和 `UNSUPPORTED_POLICY=reject`：平台不委托 Bandwidth，也不需要 signer、资源钱包地址或私钥。未绑定地址在资源估算和供应商下单前直接拒绝。对于用户原交易，java-tron 按“质押带宽整笔够 → 免费带宽整笔够 → 用户 TRX 支付整笔字节费”选择一种 Bandwidth 来源，两个带宽池不会相加。网关在 ENERGY 付费外呼前读取实时链参数并校验用户余额与 `MAX_OWNER_BANDWIDTH_BURN_SUN`；自动燃烧仅允许用于 Bandwidth，发生在广播原签名交易时，不是网关另发扣款交易。

每个交易的资源判断写入独立的 `transaction_resource_audits` 一对一审计记录。它只保存白名单指标：原始/安全 ENERGY、阈值、计划/实际请求套餐、下单前后可用量、带宽来源、预计用户 TRX 消耗、交易及链上 `fee_limit` 上下界，以及 SolidityNode 固化回执中的实际 ENERGY、Bandwidth 和费用；不保存完整 receipt、合约返回数据、签名或密钥。

外部 ENERGY 是付费动作。当 `GATEWAY_MODE=sponsor` 且 `ENERGY_SOURCE=provider` 时，绑定地址必须使用有限的 `maxTransactions`；管理页面隐藏“不限次数”，历史无限绑定必须先改为有限值才能保存。重置次数不会撤销历史供应商扣费，并会重新授予该地址付费容量；地址仍有在途锁或 `ORDERING/ACCEPTED/UNKNOWN` 订单时，服务端必须拒绝重置。

## 管理面

同一个 AdminServer 提供固定白名单内的静态页面和 `/v1/*` 管理 API，但仅监听 `127.0.0.1:8080`。管理员通过 SSH 隧道在本机访问。Bearer Token 只保存在当前页面的 JavaScript 内存，刷新或关闭页面即清除；供应商 API Key 提交后立即清空，响应中只包含 `apiKeyConfigured`。

## 当前明确边界

- 用户交易仅支持单合约、单签名、owner permission 0；多签和 active permission 默认拒绝。
- 默认仅允许 Mainnet USDT 的 `transfer` 与 `approve`，其他调用需显式加入白名单。
- `ENERGY_SOURCE=self` 时，资源钱包必须已经通过 Stake 2.0 冻结足够 TRX，并拥有可委托额度。
- `ENERGY_SOURCE=provider` 时只向已内置、固定 Endpoint 的适配器购买 ENERGY；目前支持快租。供应商不负责 Bandwidth。
- 本机局域网测试仍是 Mainnet 真交易。`observe` 不委托资源，但钱包广播的交易仍会被转发到主网。
