# 局域网 VPS 部署与测试

当前测试拓扑：

- java-tron FullNode：`{FULLNODE_IP}`
- 无感资源网关 VPS：`{GATEWAY_IP}`
- 受信局域网：`{TRUSTED_LAN_CIDR}`
- 管理页面/API：VPS 回环地址 `127.0.0.1:8080`，只能经 SSH 隧道访问

java-tron 的 `8090/8091/50051` 可以按当前需求供受信局域网设备访问，但不得配置公网 IPv4 端口转发，也不得通过公网 IPv6 暴露。网关 `50051` 对局域网开放；管理端口 `8080` 和 signer 端口 `8787` 均不得对局域网或公网开放。

## 明早操作清单

以下流程采用“快租完整覆盖安全 ENERGY、用户原交易自行使用 Bandwidth/受限燃烧 TRX”的组合，因此不需要资源钱包、私钥或 signer。ENERGY 不允许从用户 TRX 直通补差。

1. 在工作电脑建立 SSH 隧道，并保持该终端窗口打开：

   ```bash
   ssh -N -L 18080:127.0.0.1:8080 {SSH_USER}@{GATEWAY_IP}
   ```

2. 在另一终端登录 VPS，确认网关处于已经部署好的付费供应商模式：

   ```bash
   ssh {SSH_USER}@{GATEWAY_IP}
   sudo grep -E '^(GATEWAY_MODE|ENERGY_SOURCE|SPONSOR_ENERGY|SPONSOR_BANDWIDTH|ADMIN_LISTEN_HOST)=' /etc/tron-seamless/gateway.env
   sudo systemctl status seamless-gateway --no-pager
   ```

   预期值是 `GATEWAY_MODE=sponsor`、`ENERGY_SOURCE=provider`、`SPONSOR_ENERGY=true`、`SPONSOR_BANDWIDTH=false` 和 `ADMIN_LISTEN_HOST=127.0.0.1`。不要假设供应商或绑定为空；继续前必须在管理页核对当前启停、次数与预算。

3. 仅在 SSH 终端中读取管理 Token，复制后清屏；不要把它发到聊天、截图或写进浏览器 URL：

   ```bash
   sudo awk -F= '$1=="ADMIN_TOKEN"{print substr($0,index($0,"=")+1)}' /etc/tron-seamless/gateway.env
   clear
   ```

4. 在工作电脑浏览器打开 `http://127.0.0.1:18080/`，输入管理 Token。页面应显示 `SPONSOR`，并展示真实供应商、绑定地址和 UTC 当日预算；快租单笔全局上限应至少为 131,000 ENERGY。Token 只在该页面内存中保存，刷新后必须重新输入。

5. 在“能量供应商”中添加快租：

   - 类型：`快租`
   - Endpoint：确认只读显示 `https://api.kuaizu.io/api/rent`
   - 名称：例如 `快租-主通道`
   - API Key：直接粘贴，不通过聊天传递；保存后页面不会回显
   - 优先级：首家可填 `100`，数字越小越优先
   - 租用时长：`15` 代表 15 分钟，`1` 代表 1 小时
   - 单笔 ENERGY 上限：首次保持快租默认及最高值 `131000`
   - 快租只接受 `65000` 或 `131000`；先按原始估算与默认阈值 `100000` 选档，但小档无法覆盖 15% 安全缺口时自动升为 `131000`，大档仍不足则拒绝，并按实际套餐量计入预算
   - 每日订单上限：首次保持默认 `10`
   - 每日 ENERGY 上限：首次保持默认 `1000000`
   - 新建时固定为停用；保存后先核对其他配置，再从卡片单独启用
   - 首次只配置这一家供应商；当前截图契约没有业务幂等号/订单查询，先不要配置自动后备供应商

6. 在“地址与次数”中添加已激活、非合约的专用小额测试地址，次数先设为 `1`，确认地址、USDT 合约白名单、TRX 小额余额和到期时间。当前 `sponsor + provider` 模式不允许“不限次数”。若质押或免费 Bandwidth 任一池都无法独立覆盖整笔交易，节点会燃烧整笔字节费；默认单笔上限为 1 TRX。

7. 在供应商仍停用时完成最后复核：FullNode 和数据库状态正常、快租 Key 显示“已配置”、绑定上限为 1、signer 为非必需且未运行。点击供应商卡片中的“查询余额/价格”，确认后端可读取快租余额和参考单价；该动作只调用 `/api/balance`，不会创建租单或扣次数。可以验证 TronLink 只读查询，但不要点击广播。

8. 完成核对后，在页面明确确认并启用快租供应商。环境文件已经是 `sponsor + provider`，无需修改配置或重启服务。启用后新的已绑定 Mainnet 交易可能立即产生付费订单：

   ```bash
   sudo systemctl status seamless-gateway --no-pager
   sudo systemctl is-active seamless-signer
   journalctl -u seamless-gateway --since '2 minutes ago' --no-pager
   ```

   `seamless-signer` 应保持 inactive。若它正在运行，先停止并禁用，因为当前 provider-only 组合不需要私钥：

   ```bash
   sudo systemctl disable --now seamless-signer
   ```

9. 让 TronLink 通过该网关现场创建并立即发送一笔可承受损失的小额 TRC20 转账，只做一笔；不要使用离线保存或其他节点生成的旧交易。依次确认：最近请求记录里的原始/安全 ENERGY、65,000/131,000 套餐、到账增量、Bandwidth 来源和预计燃烧额，随后确认供应商订单 `FULFILLED`、用户交易被 FullNode 接受、SolidityNode 最终指标已回填、使用次数增加为 1。

10. 若订单显示 `UNKNOWN`、`ENERGY_PROVIDER_OUTCOME_UNKNOWN` 或确认超时，立即停止。该次额度会按“可能已扣费”保守消费，不会因原交易未广播而归还。不要重新下单、不要切换供应商、不要重新构造等价交易；先在快租后台、链上账户资源和本地订单记录中人工核对是否已经扣费或到账。

管理页故意不提供 `UNKNOWN` 的一键解锁：当前快租截图契约没有供应商侧幂等号和订单查询接口，贸然解锁可能让迟到的第一单与第二单叠加扣费。另请把全局/单供应商预算理解为最坏损失上限，而不是交易有效性保证。

## 完整部署参考

### 1. 安装运行环境

当前 VPS 是 Ubuntu 26.04；项目要求 Node.js 22+ 和 PostgreSQL。创建独立系统用户：

```bash
sudo groupadd --system tron-seamless
sudo groupadd --system tron-signer
sudo useradd --system --home /opt/tron-seamless --shell /usr/sbin/nologin --gid tron-seamless tron-seamless
sudo useradd --system --home /opt/tron-seamless --shell /usr/sbin/nologin --gid tron-signer tron-signer
sudo install -d -o root -g root -m 0755 /opt/tron-seamless
sudo install -d -o root -g root -m 0750 /etc/tron-seamless
```

把项目复制到 `/opt/tron-seamless`，然后：

```bash
cd /opt/tron-seamless
npm ci
npm run typecheck
npm test
npm run build
sudo chown -R root:root /opt/tron-seamless
sudo find /opt/tron-seamless -type d -exec chmod 0755 {} +
sudo chmod -R a+rX,go-w /opt/tron-seamless
```

源代码和依赖由 `root:root` 持有；目录为 `0755`，两个服务账户只能读取/执行所需代码，不能修改。秘密不放在代码目录。网关只读取 `0640 root:tron-seamless` 的 `gateway.env`；如果以后启用自有资源 signer，它只能读取 `0640 root:tron-signer` 的 `signer.env`，两个服务用户不加入彼此的附加组。

### 2. PostgreSQL

```bash
sudo -u postgres createuser --pwprompt seamless
sudo -u postgres createdb --owner=seamless seamless
sudo -u tron-seamless env DATABASE_URL='postgresql://seamless:密码@127.0.0.1:5432/seamless' npm run migrate
```

迁移会创建地址、广播请求、自有资源租约、供应商及供应商订单表。数据库只监听回环地址。生产密码不要出现在 shell 历史中；正式部署使用 `/etc/tron-seamless/gateway.env`，权限为 `0640 root:tron-seamless`。

### 3. Provider-only 初始配置

复制 `deploy/gateway.env.example` 到 `/etc/tron-seamless/gateway.env`。当前部署直接使用 `sponsor + provider`，但在供应商和绑定地址为空时会安全拒绝，不会外呼或下单：

```ini
GATEWAY_MODE=sponsor
AUTH_MODE=bound_address
AUTH_ENFORCE_IN_OBSERVE=false
ADMIN_LISTEN_HOST=127.0.0.1
SPONSOR_ENERGY=true
SPONSOR_BANDWIDTH=false
ENERGY_SOURCE=provider
PROVIDER_MASTER_KEY=一枚独立的32字节随机密钥
PROVIDER_ORDER_TIMEOUT_MS=5000
PROVIDER_CONFIRM_TIMEOUT_MS=10000
PROVIDER_POLL_MS=250
KUAIZU_PACKAGE_THRESHOLD=100000
ALLOW_OWNER_BANDWIDTH_BURN=true
MAX_OWNER_BANDWIDTH_BURN_SUN=1000000
ALLOW_OWNER_ENERGY_BURN=false
MAX_OWNER_ENERGY_BURN_SUN=5000000
PROVIDER_MAX_ENERGY_PER_ORDER=131000
PROVIDER_DAILY_MAX_ORDERS=20
PROVIDER_DAILY_MAX_ENERGY=2000000
```

用 `openssl rand -hex 32` 生成 `PROVIDER_MASTER_KEY`，只写入环境文件。不要把快租 API Key 写进环境文件；它应通过管理页提交，并加密后写入数据库。在 provider-only 组合中删除或留空 `RESOURCE_OWNER_ADDRESS`，不创建 `signer.env`，不启动 signer。

安装并启动网关：

```bash
sudo chown root:tron-seamless /etc/tron-seamless/gateway.env
sudo chmod 0640 /etc/tron-seamless/gateway.env
sudo cp deploy/systemd/seamless-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now seamless-gateway
```

验证本机服务：

```bash
curl http://127.0.0.1:8080/healthz
curl -H 'Authorization: Bearer {ADMIN_TOKEN}' http://127.0.0.1:8080/readyz
journalctl -u seamless-gateway -f
```

不要把管理服务改成 `0.0.0.0`。管理页只通过如下隧道访问：

```bash
ssh -L 8080:127.0.0.1:8080 {SSH_USER}@{GATEWAY_IP}
```

### 4. 地址、次数和供应商

推荐使用管理页面。它支持：

- 查看网关、FullNode、数据库与运行模式；
- 添加或编辑绑定地址、总次数、到期时间和启停状态；
- 二次确认后清零已用次数；
- 独立配置每家供应商的名称、优先级、租期、三项预算与 API Key；
- 手动查询每家供应商的余额、参考单价与套餐参考成本，不自动轮询；
- 按供应商分别查看订单，不混合不同供应商的数据；
- 查看最近广播请求，但不展示内部错误详情或任何秘密。

CLI 仍可用于地址规则：

```bash
export ADMIN_URL=http://127.0.0.1:8080
export ADMIN_TOKEN='{ADMIN_TOKEN}'
npm run admin -- bind T测试地址 1 lan-test
npm run admin -- list
```

更新同一地址的上限不会清零 `usedTransactions`。重置会把已用次数归零并重新授予可产生付费订单的容量，但绝不会撤销历史供应商扣费。同一地址一次只允许一笔未决付费交易；存在地址锁、`reservedTransactions` 或 `ORDERING/ACCEPTED/UNKNOWN` 供应商订单时，重置返回 HTTP 409。尤其不能在 `UNKNOWN` 后通过重置来再次下单。

供应商 API Key 使用 AES-256-GCM 加密保存，管理页和 API 只返回 `apiKeyConfigured`。编辑时 Key 留空表示保留旧值。`PROVIDER_MASTER_KEY` 丢失后无法解密已有供应商凭据，需要重新录入 Key。

全局与逐供应商预算都按 UTC 自然日统计，并在外呼前由 PostgreSQL 原子检查。`ORDERING`、`ACCEPTED`、`FULFILLED`、`UNKNOWN` 占用两层订单和 ENERGY 额度，明确拒绝才释放。全局预算卡只读；每张供应商卡显示该供应商已用和剩余。快租默认且最高单笔 131,000 ENERGY、每日 10 单、每日 1,000,000 ENERGY；预算按实际购买的 65,000/131,000 套餐计算。任一层剩余订单或 ENERGY 不足一个完整套餐时均不得继续测试。

### 5. TronLink 局域网配置

在 TronLink App 中增加自定义节点：

- Host：`{GATEWAY_IP}`
- Port：`50051`
- TLS/SSL：关闭（仅限受信局域网测试）

全节点仍是 `{FULLNODE_IP}`，不要把 TronLink 的无感节点配置误指向 FullNode。供应商和绑定尚未启用前先做只读查询；当前已是 `sponsor`，不要通过广播来做“观察模式”验证。

### 6. 启用供应商前核对

部署从启动时就是 `GATEWAY_MODE=sponsor`，供应商和绑定为空构成安全闸门，不需要再修改环境文件或重启。满足以下条件后才在页面启用供应商：

- FullNode 和 SolidityNode 已同步，`estimateenergy` 正常；
- 测试地址、次数、到期时间和 USDT 白名单正确；
- 快租 Endpoint 在页面中是固定只读值，API Key 显示为已配置；
- 供应商最初停用时已经完成配置复核，随后由管理员明确启用；
- `SPONSOR_BANDWIDTH=false`，已复核用户 Bandwidth/TRX 燃烧开关、单笔上限、余额与签名 `fee_limit`；
- `ALLOW_OWNER_ENERGY_BURN=false`；65,000 套餐不能覆盖安全缺口时会升级为 131,000，仍不足时必须拒绝；
- `seamless-signer` 未启动，系统不存在资源钱包私钥；
- 网关 `50051` 只允许受信局域网，管理 `8080` 仅监听回环地址。

```bash
sudo systemctl status seamless-gateway --no-pager
journalctl -u seamless-gateway --since '2 minutes ago' --no-pager
```

首次只发一笔小额交易。成功顺序是：估算资源缺口、供应商接受订单、链上确认 ENERGY 到账、广播用户原交易、SolidityNode 最终确认、`usedTransactions` 增加 1。

### 7. 可选的自有资源模式

当前实现不支持 `ENERGY_SOURCE=provider` 与 `SPONSOR_BANDWIDTH=true` 组合；provider sponsor 必须保持 `SPONSOR_BANDWIDTH=false`。只有切回 `ENERGY_SOURCE=self` 后，才可配置 `RESOURCE_OWNER_ADDRESS`、独立 `signer.env` 和 `seamless-signer` 来赞助 ENERGY/Bandwidth。资源钱包必须已通过 Stake 2.0 冻结足够 TRX，私钥只允许存在于 `/etc/tron-seamless/signer.env`，权限为 `0640 root:tron-signer`。
