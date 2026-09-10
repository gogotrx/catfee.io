# TRON 无感资源网关（完全自建）

这是一个面向 TronLink App 自定义节点的 Node.js/TypeScript gRPC 网关。钱包在本地签名；网关校验签名和绑定规则，在广播前准备 ENERGY/BANDWIDTH，再把用户原始交易不加修改地广播到自己的 java-tron。ENERGY 可以来自自有 Stake 2.0 资源钱包，也可以由独立的外部供应商模块提供。

`{GATEWAY_IP}` 按 `sponsor + provider` 部署。供应商、绑定和预算是可变运行数据，必须以管理页当前状态为准；供应商已启用且地址仍有次数时，新的 Mainnet 广播可能立即产生真实付费订单。完整拓扑和时序见 [docs/architecture.md](docs/architecture.md)，测试步骤见 [docs/lan-runbook.md](docs/lan-runbook.md)，上线前必读 [docs/security.md](docs/security.md)。

## 功能

- 精确的 `/protocol.Wallet/BroadcastTransaction` 由策略引擎接管；只有按 java-tron `v4.8.2.1/f8b05d40` 审核过的钱包查询和未签名交易构造 RPC 才透明代理，其余未知、变形或新增方法默认拒绝。
- 校验用户交易 SHA-256 `txID`、secp256k1 签名和 `owner_address`。
- 地址绑定、总次数、已使用次数、并发预留次数、到期时间和启停。
- 默认仅赞助 Mainnet USDT `transfer/approve` 和普通 TRX 转账。
- `/wallet/estimateenergy` 估算 ENERGY；从账户和全局资源参数计算委托量。
- PostgreSQL 交易幂等、广播响应缓存和资源租约。
- 可选择自有资源模式，使用独立 loopback signer；网关进程不读取资源钱包私钥。
- 可选择外部供应商模式；当前内置快租适配器，租用接口固定为 `https://api.kuaizu.io/api/rent`，账户查询接口固定为 `https://api.kuaizu.io/api/balance`。
- 供应商 API Key 使用 AES-256-GCM 加密后保存，管理 API 和页面只返回“是否已配置”，绝不回显 Key。
- 中文管理页面维护地址、次数、供应商和订单；管理服务只监听回环地址，通过 SSH 隧道访问。
- SolidityNode 最终确认与异步取消委托。
- `passthrough / observe / sponsor` 三种运行模式。

## 本地开发

需要 Node.js 22+ 和 PostgreSQL：

```bash
npm install
docker compose -f docker-compose.dev.yml up -d
$env:DATABASE_URL='postgresql://seamless:replace_me@127.0.0.1:5432/seamless'
npm run migrate
npm run typecheck
npm test
npm run build
```

把 `.env.example` 拆成网关与 signer 环境变量使用，不要创建包含真实私钥、供应商 API Key 或主加密密钥且可能误提交的配置文件。

## 地址与次数

管理 API 和中文管理页默认位于 `127.0.0.1:8080`，不能从局域网或公网直接打开。先建立 SSH 隧道：

```bash
ssh -L 8080:127.0.0.1:8080 {SSH_USER}@{GATEWAY_IP}
```

然后在本机打开 `http://127.0.0.1:8080/`。管理 Token 只保存在当前页面的 JavaScript 内存，刷新后需要重新输入；不要通过明文公网 HTTP 使用页面。CLI 示例：

```bash
$env:ADMIN_URL='http://127.0.0.1:8080'
$env:ADMIN_TOKEN='{AccessKey}'
npm run admin -- bind TAddress 10 test-user
npm run admin -- list
npm run admin -- disable TAddress
```

自有资源路径通常在上游节点接受用户交易后消费次数，明确广播拒绝会归还预留次数。外部付费供应商路径更保守：订单一旦 `ACCEPTED`、`UNKNOWN` 或发生“可能已经扣费”的异常就立即消费次数，即使用户原交易尚未广播或后来失败也不归还；只有所有供应商都明确拒绝时才归还。同一个 `txID` 重试不会重复计数或重复下单。

## 外部 ENERGY 供应商

使用快租供应 ENERGY 时，网关设置：

```ini
SPONSOR_ENERGY=true
SPONSOR_BANDWIDTH=false
ENERGY_SOURCE=provider
ALLOW_OWNER_BANDWIDTH_BURN=true
MAX_OWNER_BANDWIDTH_BURN_SUN=1000000
ALLOW_OWNER_ENERGY_BURN=false
MAX_OWNER_ENERGY_BURN_SUN=5000000
KUAIZU_PACKAGE_THRESHOLD=100000
PROVIDER_MASTER_KEY=64位十六进制或标准Base64编码的32字节随机密钥
PROVIDER_MAX_ENERGY_PER_ORDER=131000
PROVIDER_DAILY_MAX_ORDERS=20
PROVIDER_DAILY_MAX_ENERGY=2000000
```

在这种组合下，不需要配置 `RESOURCE_OWNER_ADDRESS`，也不需要启动 signer。快租的 `rentTime=1` 代表 1 小时，`rentTime=15` 代表 15 分钟。`SPONSOR_BANDWIDTH=false` 表示平台不委托 Bandwidth；用户原交易广播时，java-tron 会先尝试用一整个质押带宽池，再尝试一整个免费带宽池，两者都无法独立覆盖整笔交易时才从用户余额燃烧整笔带宽费。免费桶还依赖 `getaccountresource` 未返回的全链公共池，因此即使账户免费桶充足，网关也会按“公共池不足时整笔烧 TRX”的最坏情况校验 `getTransactionFee`、用户余额和单笔燃烧上限，不会另外签名或扣款。

当运行模式为 `sponsor` 且 `ENERGY_SOURCE=provider` 时，每个绑定地址都必须设置有限总次数，管理页会禁用“不限次数”。同一地址一次只允许一笔未决付费交易；已有地址锁或 `ORDERING/ACCEPTED/UNKNOWN` 订单时，新交易会在下单前拒绝，次数重置也会阻断。重置不会撤销历史扣费，归零后会重新授予可产生付费订单的容量。

每家供应商独立配置 `maxEnergyPerOrder`、`dailyOrderLimit`、`dailyEnergyLimit`；快租默认分别为 131,000 ENERGY、10 单、1,000,000 ENERGY。快租只接受 65,000 或 131,000 两档：先按原始 `estimateenergy < KUAIZU_PACKAGE_THRESHOLD` 选择 65,000，否则选择 131,000；默认阈值是 100,000。provider 生产模式禁止用户 ENERGY 燃烧，所以当 65,000 不能覆盖“15% 安全总 ENERGY－账户现有 ENERGY”时会自动升级为 131,000；131,000 仍不足则不下单、不广播。供应商到账后还会立即重查账户 ENERGY，未达到安全总量就停止广播。签名交易的 `fee_limit` 仍必须覆盖安全总 ENERGY 且不超过链上上限。预算始终按实际套餐量占用。

供应商卡片可手动查询快租余额和参考价格。浏览器只向本机管理 API 发送供应商 ID；服务端在内存中解密 Key，并向固定的 `/api/balance` 发送一次只读请求，不创建租单、不占预算也不扣用户次数。页面按返回的 `price` 展示 65,000/131,000 参考成本，但真实扣费仍以 `/api/rent` 成功响应中的 `orderMoney` 为准；该查询不会随页面定时刷新自动调用。

`{GATEWAY_IP}:50051` 使用 `sponsor + provider`。供应商启用后，任何已绑定且仍有次数的地址都可能产生真实付费订单；未绑定或已停用地址直接拒绝。生产配置只允许用户 TRX 支付 Bandwidth，不允许把 ENERGY 缺口直通给用户余额；修改档位阈值或 Bandwidth 燃烧上限需要更新受保护的环境文件并重启网关。

供应商请求以用户交易 `txID` 幂等。网络超时、HTTP 结果不明确或响应无法验证时，订单进入 `UNKNOWN`，系统不会自动向同一或下一供应商重新下单；必须先在供应商后台和链上人工核对，防止重复购买。

这里的幂等边界首先由本地 PostgreSQL 保证。当前快租截图所示请求没有供应商侧业务幂等号或订单查询接口，因此它弱于支持 `client_order_id` 的供应商：发生 `UNKNOWN` 后系统会永久保留该地址的安全锁，管理页也不会提供“一键重试/解锁”。只有拿到快租书面补充契约并人工核清订单后，才能设计结案动作。首次只配置一家供应商；在确认 `code != 1` 绝不接单、绝不扣费之前，不要依赖跨供应商自动切换。

全局预算与逐供应商预算都会在外呼前由 PostgreSQL 原子检查，按 UTC 自然日统计，先触达任一上限即拒绝。`ORDERING`、`ACCEPTED`、`FULFILLED` 和 `UNKNOWN` 占用当日订单与 ENERGY 额度，明确拒绝才释放。全局预算在管理页只读；逐供应商三项上限可编辑，并在供应商卡片显示已用和剩余。

预算只是最坏付费损失上限，不代表用户交易一定会被链上接受。外呼前会拒绝未激活/合约接收地址、与当前 owner permission 不匹配的签名、无效 TAPOS、已经入链或仍在 FullNode pending pool 的同一 txID、非空 `Transaction.ret`、超过 java-tron 保守尺寸上限、用户资源费超出余额或配置上限、低于安全总 ENERGY 或高于链上上限的 `fee_limit`、非空 memo、陈旧时间戳、过远 expiration、非标准长度的 TRC20 `transfer/approve` calldata 及携带 TRX/TRC10 value 的调用。每笔测试会单独记录原始/安全 ENERGY、档位阈值、计划/实际请求套餐、到账增量、带宽来源、预计燃烧额、`fee_limit` 上下界，以及 SolidityNode 固化后的实际 ENERGY/Bandwidth/费用；供应商订单另记成本、余额、代理交易哈希和各次尝试，便于用真实结果调整 65,000/131,000 规则。

## 重要提醒

局域网只是隔离了入口，不会把 Mainnet 变成测试网。只要网关连接的是 Mainnet java-tron，TronLink 点击广播就可能产生真实链上交易；即使使用 `observe` 也会继续广播，只是不准备资源。当前部署无需再切换模式：先让供应商保持停用，使用新建的小额地址验证查询和规则，完成复核后再明确启用供应商。外部供应商超时后不要盲目重试或重新发送交易。
