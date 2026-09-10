# 脱敏源码包交付与部署说明

本说明适用于 `tron-seamless-gateway` 脱敏源码包。包内不包含任何正在运行环境的 API Key、管理 Token、数据库密码、钱包私钥、SSH 密钥、数据库、日志或真实局域网地址。文档中的 `{FULLNODE_IP}`、`{GATEWAY_IP}`、`{TRUSTED_LAN_CIDR}` 和 `{SSH_USER}` 必须由部署人员在自己的环境中替换。

包内有意保留以下公开兼容性常量，它们不是凭据：TRON Mainnet USDT 合约地址、供应商公开 HTTPS Endpoint、java-tron 版本/提交标识、TRC20 函数选择器，以及仅用于断言的测试地址。

## 1. 系统用途

本项目是供 TronLink App 使用的 Node.js/TypeScript plaintext gRPC 网关。用户交易始终在钱包本地签名，网关从签名恢复 `owner_address`，检查该地址的绑定、次数、到期时间和交易白名单，在广播前准备 ENERGY，最后把用户原始交易不加修改地转发给自建 java-tron。

推荐的 provider-only 拓扑：

```text
TronLink App
  │ plaintext gRPC :50051
  ▼
Gateway {GATEWAY_IP}
  ├─ PostgreSQL：用户绑定、次数、幂等请求、供应商、订单、审计
  ├─ HTTPS：ENERGY 供应商适配器
  └─ java-tron {FULLNODE_IP}
       ├─ gRPC :50051
       ├─ FullNode HTTP :8090
       └─ Solidity HTTP :8091
```

多用户不是靠 TronLink API Key 区分。每笔交易都用 secp256k1 签名恢复出的真实 owner 地址作为用户身份；数据库以该地址保存总次数、已使用次数、预留次数、有效期和启停状态。同一个地址只允许一笔未决付费交易，从而避免并发重复租能量。

## 2. 包内内容与排除项

包含：

- `src/`：网关、交易校验、资源策略、供应商抽象、管理 API、后台任务；
- `web/`：中文管理页面；
- `sql/`：PostgreSQL 迁移；
- `proto/`：最小 TRON protobuf；
- `test/`：单元与集成测试；
- `deploy/`：环境变量模板、systemd 与防火墙示例；
- `docs/`：架构、安全与部署说明；
- npm 锁文件、TypeScript 配置和开发用 Compose 文件。

不包含：

- `node_modules/`、`dist/`、coverage 和其他可重建产物；
- `.env`、真实 systemd EnvironmentFile 或其他运行配置；
- PostgreSQL 数据目录、dump、运行日志、PID、备份和旧文件；
- Git 元数据、IDE 配置、压缩包、证书、SSH 文件或钱包密钥。

根目录 `PACKAGE-MANIFEST.txt` 是包内文件清单。压缩包旁的 `.sha256` 文件用于校验下载或复制是否损坏。

## 3. 前置条件

- Node.js 22 或更高版本；
- PostgreSQL 15 或更高版本；
- java-tron `GreatVoyage-v4.8.2.1`（提交 `f8b05d40`）或经过重新审计的兼容版本；
- FullNode 已同步目标网络，且网关可访问其 gRPC、HTTP 与 Solidity HTTP；
- 若使用外部供应商，网关可通过 HTTPS 访问该供应商固定 Endpoint。

java-tron 至少需要启用：

```hocon
vm = {
  supportConstant = true
  maxEnergyLimitForConstant = 100000000
  estimateEnergy = true
  estimateEnergyMaxRetry = 3
}

node.http.fullNodeEnable = true
node.http.fullNodePort = 8090
node.http.solidityEnable = true
node.http.solidityPort = 8091
storage.transHistory.switch = "on"
trx.reference.block = "solid"
```

确认 `node.disabledApi` 没有禁用估算、账户资源、交易查询或广播所需接口。升级 java-tron 前必须重新审核 `src/grpc/upstream-policy.ts` 的 RPC 白名单；当前白名单固定于上述版本，不能把未知新增 RPC 自动放行。

## 4. 安装与构建

在解压后的项目根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

本地开发可以启动只监听回环地址的 PostgreSQL：

```bash
docker compose -f docker-compose.dev.yml up -d
```

复制 `.env.example` 或 `deploy/gateway.env.example` 到项目目录之外的受保护位置，再逐项配置。不要把真实值写回源码目录，也不要提交任何 `.env`。

执行迁移：

```bash
DATABASE_URL='postgresql://seamless:{DATABASE_PASSWORD}@127.0.0.1:5432/seamless' npm run migrate
```

生产服务可参考 `deploy/systemd/`。默认安装路径是 `/opt/tron-seamless`，运行秘密建议存放在 `/etc/tron-seamless/gateway.env`，权限设为 `0640 root:tron-seamless`。

## 5. 必须单独生成的秘密

以下值必须在目标服务器上独立随机生成，彼此不能复用：

- `ADMIN_TOKEN`：至少 32 个随机字符；
- `PROVIDER_MASTER_KEY`：恰好 32 字节，用 64 位十六进制或标准 Base64 表示；
- `SIGNER_TOKEN`：仅在自有资源 signer 模式使用，至少 32 个随机字符；
- PostgreSQL 密码；
- `RESOURCE_PRIVATE_KEY`：仅在自有资源模式使用，绝不能进入网关环境、数据库、日志或备份。

可在安全终端中分别执行 `openssl rand -hex 32` 生成随机值。不要把输出发送到聊天、工单或截图。供应商 API Key 只通过管理页面录入；服务端用 AES-256-GCM 加密后写入 PostgreSQL，API 与页面只返回“是否已配置”，不会回显明文。

provider-only 模式不需要资源钱包、`RESOURCE_PRIVATE_KEY` 或 signer 服务。只有 `ENERGY_SOURCE=self` 才配置这些内容。

## 6. Provider-only 关键配置

以下配置表达“平台购买 ENERGY；用户自己的交易使用可用 Bandwidth，必要时在上限内燃烧用户 TRX 支付 Bandwidth；绝不让 ENERGY 缺口直通燃烧用户 TRX”：

```ini
GATEWAY_MODE=sponsor
GATEWAY_LISTEN_HOST=0.0.0.0
GATEWAY_GRPC_PORT=50051

UPSTREAM_GRPC_URL=http://{FULLNODE_IP}:50051
NODE_HTTP_URL=http://{FULLNODE_IP}:8090
NODE_SOLIDITY_HTTP_URL=http://{FULLNODE_IP}:8091

DATABASE_URL=postgresql://seamless:{DATABASE_PASSWORD}@127.0.0.1:5432/seamless
ADMIN_LISTEN_HOST=127.0.0.1
ADMIN_PORT=8080
ADMIN_TOKEN={ADMIN_TOKEN}

AUTH_MODE=bound_address
UNSUPPORTED_POLICY=reject
INSUFFICIENT_POLICY=reject

SPONSOR_ENERGY=true
SPONSOR_BANDWIDTH=false
ENERGY_SOURCE=provider
ALLOW_OWNER_BANDWIDTH_BURN=true
MAX_OWNER_BANDWIDTH_BURN_SUN=1000000
ALLOW_OWNER_ENERGY_BURN=false

ESTIMATE_SAFETY_BPS=11500
KUAIZU_PACKAGE_THRESHOLD=100000
PROVIDER_MASTER_KEY={PROVIDER_MASTER_KEY}
PROVIDER_MAX_ENERGY_PER_ORDER=131000
PROVIDER_DAILY_MAX_ORDERS=20
PROVIDER_DAILY_MAX_ENERGY=2000000
```

不要把带花括号的示例直接用于生产。先换成真实值，并确保 `ADMIN_LISTEN_HOST` 保持 `127.0.0.1`。

## 7. ENERGY 档位与 Bandwidth 规则

快租适配器只提交 `65,000` 或 `131,000` ENERGY：

1. 原始 `estimateenergy` 小于 `KUAIZU_PACKAGE_THRESHOLD` 时先选 65,000，否则选 131,000；
2. 系统把原始估算乘以 `ESTIMATE_SAFETY_BPS`。默认 11500 表示保留 15% 安全余量；
3. 如果 65,000 无法覆盖“安全总 ENERGY 减去用户已有 ENERGY”，自动升级到 131,000；
4. 131,000 仍不足时不下单、不广播；
5. 供应商返回成功后，系统等待链上 ENERGY 到账，并在紧邻广播前再次查询；不足时停止广播。

例如原始估算 83,170，默认安全值约为 95,646，明显超过 65,000，因此应购买 131,000，而不是按原始估算随意购买一个中间值。

Bandwidth 由 java-tron 按“质押带宽整笔足够 → 免费带宽整笔足够 → 用户 TRX 支付整笔字节费”选择来源。网关会按最坏情况检查余额和 `MAX_OWNER_BANDWIDTH_BURN_SUN`。该开关只允许 Bandwidth 费用，`ALLOW_OWNER_ENERGY_BURN=false` 必须保持不变。

## 8. 地址、次数与扣次语义

provider 模式中的每个绑定地址必须有有限次数，不能使用“不限次数”。推荐首次测试：新地址、小额余额、次数 1、明确到期时间。

扣次取决于供应商是否可能产生费用：

- 所有供应商都明确拒绝、确认未扣款：释放地址锁并退回预留次数；
- 供应商 `ACCEPTED`、`FULFILLED`：消费一次；
- 网络超时、无效响应或结果不确定：记为 `UNKNOWN`，保守消费一次并保持安全锁；
- 已经可能扣费后，即使用户交易没有广播或最终失败，也不自动退次数；
- 同一个 `txID` 重试不会重复下单或重复扣次。

`UNKNOWN` 不是可自动重试的失败。必须先在供应商后台、链上账户资源和本地订单记录中人工核对。当前管理页面故意不提供危险的“一键解锁”。

## 9. 管理页面与网络边界

管理页面和管理 API 只能监听 `127.0.0.1:8080`。通过 SSH 隧道访问：

```bash
ssh -N -L 18080:127.0.0.1:8080 {SSH_USER}@{GATEWAY_IP}
```

然后打开 `http://127.0.0.1:18080/`。Token 只保存在当前页面的 JavaScript 内存，刷新或关闭后清除。不要把 Token 放入 URL，也不要把管理端口开放到局域网或公网。

只把网关 `50051` 开放给 `{TRUSTED_LAN_CIDR}`。java-tron 的 API 端口只应对网关或明确受信任的局域网设备开放，绝不能做公网 IPv4 端口转发或通过公网 IPv6 暴露。公网阶段还需增加专用入口、来源限制、连接速率限制和 DDoS 防护。

TronLink 自定义节点示例：

- Host：`{GATEWAY_IP}`；
- Port：`50051`；
- TLS/SSL：在只受信局域网使用 plaintext；公网部署需按客户端兼容性设计安全入口。

## 10. 首次安全测试

1. 保持供应商停用，先确认网关、FullNode、SolidityNode、数据库和 `/wallet/estimateenergy` 正常；
2. 新建供应商，录入 API Key，设置 131,000 单笔上限、很小的每日订单/ENERGY 上限，保存后仍保持停用；
3. 使用“查询余额/价格”验证凭据。这个动作只调用余额接口，不创建租单、不占预算、不扣地址次数；
4. 绑定一个已激活、非合约的小额测试地址，次数设为 1；
5. 核对 `ALLOW_OWNER_ENERGY_BURN=false`、Bandwidth 燃烧上限和 USDT 白名单；
6. 明确启用供应商，只让 TronLink 现场创建并发送一笔可承受损失的小额 TRC20 交易；
7. 依次核对估算、安全值、套餐、供应商订单、ENERGY 到账、广播响应、Solidity 最终确认和扣次；
8. 出现 `UNKNOWN`、到账不足或确认超时时立即停止，不要重新下单或构造等价交易。

注意：`observe` 只是不准备资源，并不阻止交易广播。只要连接 Mainnet，自定义节点测试就是 Mainnet 真交易。

## 11. 常见故障

- “地址不匹配数据库”：签名恢复出的 owner 没有有效绑定，或绑定已停用/过期/无剩余次数；系统应在供应商下单前直接拒绝。
- “预估约 83k 却购买 131k”：原始估算加安全余量后无法由 65k 完整覆盖，这是预期升级。
- “能量没到账但次数减少”：检查订单是否为 `ACCEPTED` 或 `UNKNOWN`；只要供应商可能已经扣费，就不会自动退次。
- “明确未扣款仍未退次”：查看供应商尝试是否被分类为明确拒绝，以及地址是否还有其他未决订单或锁。
- “直接用 TRX 支付”：确认 `ALLOW_OWNER_ENERGY_BURN=false`；只有 Bandwidth 可以在配置上限内燃烧用户 TRX。随后检查最终回执中消耗的是 `energy_fee` 还是 `net_fee`。
- “管理页打不开”：确认 SSH 隧道仍在、管理服务只监听回环地址、使用的是本机转发端口而不是服务器 8080。

## 12. 重新打包与校验

在原始工作区运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-sanitized-package.ps1 `
  -OutputDirectory "D:\release" `
  -ReleaseId "20260910"
```

脚本采用文件白名单复制，自动将运行手册中的实际拓扑替换成占位符，并在压缩前检查私钥块、64 位十六进制候选、用户专属 SSH 路径和禁止文件类型。它不会复制依赖、构建结果或运行数据。

校验压缩包：

```powershell
Get-FileHash -Algorithm SHA256 .\tron-seamless-gateway-sanitized-20260910.zip
Get-Content .\tron-seamless-gateway-sanitized-20260910.sha256
```

两处 SHA-256 必须一致。解压后仍应重新执行 `npm ci`、`npm run typecheck`、`npm test` 和 `npm run build`。
