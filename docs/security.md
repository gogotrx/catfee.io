# 安全基线

- 公网客户端只能连接经过防护的业务网关入口，绝不能直接访问 java-tron。当前局域网部署允许受信任的 `{TRUSTED_LAN_CIDR}` 设备访问 java-tron 的业务端口，以满足节点共用需求；`8090/8091/8092/50051/50061/50071` 均不得通过路由器端口转发或公网 IPv6 暴露。
- TronLink 自定义节点没有 API Key，所以生产鉴权必须使用交易签名恢复出的 owner 地址，加上地址绑定、次数和到期时间。
- `50051` 是 plaintext gRPC。局域网测试按来源网段限制；公网阶段应使用专用入口、DDoS/连接限速和源站防护，但不能在需要 plaintext 的客户端路径上强制 TLS。
- 管理 API 和管理页面仅监听 `127.0.0.1:8080`，只通过 SSH 隧道访问。不要改成 `0.0.0.0`，不要为 `8080` 添加局域网或公网防火墙放行规则。
- 管理页面与 API 必须同源，不启用宽松 CORS。Bearer Token 只保存在页面 JavaScript 内存，不写入 localStorage、sessionStorage、Cookie 或 URL；成功、失败、退出及 Token 失效时都要清除输入框和已加载数据。
- 静态文件只从专用 `web/` 目录固定白名单提供，不允许浏览项目根目录。响应保留 CSP、`nosniff`、`Referrer-Policy`、禁止 frame 和 `no-store` 等安全头；不要引入外部 CDN、脚本或样式。
- signer 默认仅监听 `127.0.0.1:8787`，systemd 同时禁止非回环网络，只接受网关 token，并再次验证合约类型、资源钱包、接收地址、资源类型和最大金额。签名过程不连接 java-tron。
- 资源私钥仅放 `/etc/tron-seamless/signer.env`，权限 `0640 root:tron-signer`。不要放入项目 `.env`、数据库、日志或备份。
- 外部供应商 API Key 经 AES-256-GCM 加密后才写入 PostgreSQL，并使用供应商类型、credential UUID 和版本作为附加认证数据。`PROVIDER_MASTER_KEY` 必须是独立的 32 字节随机密钥，仅放 `/etc/tron-seamless/gateway.env`，权限 `0640 root:tron-seamless`；它不能和 ADMIN/SIGNER token 共用，也不能进入日志或源码。
- 管理 API 永不返回供应商 API Key，管理页面只显示 `apiKeyConfigured`。编辑时 Key 留空表示保留；填写新值只用于替换并在提交后清空。备份数据库时必须同样保护密文；丢失 `PROVIDER_MASTER_KEY` 后不能解密旧凭据，需要重新录入供应商 Key。
- 快租租用与账户查询 Endpoint 分别固定为 `https://api.kuaizu.io/api/rent` 和 `https://api.kuaizu.io/api/balance`，管理页面和数据库不能修改，以避免把供应商凭据发送到任意地址。适配器拒绝重定向、限制响应大小并校验响应结构。余额/价格只允许管理员手动查询，不自动轮询，不创建订单、不占预算、不扣地址次数；`price` 仅作参考，实际费用以租单的 `orderMoney` 为准。
- `ALLOWED_CONTRACTS` 和 `ALLOWED_SELECTORS` 使用最小白名单。新增合约前需检查其实际 Energy 波动和可重入/失败行为。
- provider 生产模式强制 `INSUFFICIENT_POLICY=reject`、`UNSUPPORTED_POLICY=reject` 和 `ALLOW_OWNER_ENERGY_BURN=false`。用户 TRX 只允许在质押/免费 Bandwidth 均不足时支付受限的 Bandwidth 费；任何已知 ENERGY 安全缺口都必须由供应商套餐覆盖，否则不下单或不广播。供应商到账后紧邻广播前再次读取账户 ENERGY，读取失败或低于安全总量都闭合拒绝。
- 供应商网络超时、非确定 HTTP 结果或无效响应都视为结果不确定，订单进入 `UNKNOWN`。此时绝不自动重试同一家或下一家，也不继续广播用户交易；管理员必须先在供应商后台、订单记录及链上账户资源中人工核对。重复下单可能造成重复扣费。
- 当前快租截图契约未提供供应商侧幂等号或订单查询接口，本地 `txID` 去重不能消除“供应商已收单但响应丢失”的不确定性。因此 `UNKNOWN` 会持续锁住地址且网页不提供危险的一键结案。首次只配置一家；在供应商书面确认 `code != 1` 绝不会收单或扣费之前，不得把明确错误后的跨供应商切换视为生产保证。
- `sponsor + ENERGY_SOURCE=provider` 是外部付费模式，每个绑定地址必须设置有限总次数，禁止“不限次数”。供应商应先以停用状态保存并复核，启用前再次确认余额与测试预算；停用只阻止未来的新尝试，不会撤销已经处于 `ORDERING` 或 `ACCEPTED` 的订单。
- provider 模式对每个 owner 地址实行单笔在途闸门；地址锁或 `ORDERING/ACCEPTED/UNKNOWN` 订单未解除前，禁止该地址发起第二笔付费交易。次数重置同样必须阻断，尤其不能把 `UNKNOWN` 当成失败后归零重试；重置不会撤销历史扣费，反而会重新授予付费容量。
- 外部供应商一旦 `ACCEPTED`、`UNKNOWN` 或抛出可能已扣费的异常，就消费已预留次数；即使用户原交易没有广播或后来失败也不归还。只有所有供应商都给出明确拒绝时才释放次数。这是付费防重策略，不得改回普通广播的计数语义。
- 供应商外呼前必须同时通过数据库原子全局预算与逐供应商预算。部署快租时全局 `PROVIDER_MAX_ENERGY_PER_ORDER` 必须至少为 131000；快租逐供应商单笔上限默认且最高为 131,000 ENERGY，只能购买 65,000/131,000 两档，预算按实际套餐量而不是原始估算计算。`ORDERING/ACCEPTED/FULFILLED/UNKNOWN` 均占用两层预算，明确拒绝才释放；提高任何其他供应商上限前需重新评估单笔损失、每日最大损失和供应商账户余额。
- 预算是损失上限，不是链上有效性证明。系统还会在付费外呼前核验账户已激活且不是合约、当前链上 owner permission、最近 65,536 区块窗口内的 TAPOS 引用、实时 `getTransactionFee/getEnergyFee/getMaxFeeLimit`、Bandwidth 单池覆盖或整笔燃烧费用、用户余额、覆盖安全总 ENERGY 且不超过链上上限的 `fee_limit`、时间戳、expiration，以及 TRC20 调用的标准 68-byte calldata、空 memo 且未附带 TRX/TRC10 value。TAPOS 在准备开始及真实下单前各校验一次；不要提交离线保存或从别的节点长期缓存的签名交易。
- 为资源钱包设置较小的在线额度，并通过 `SIGNER_MAX_DELEGATE_SUN` 限制单次签名上限。大额冷资产与在线资源钱包分离。
- 当前实现强制 `GATEWAY_MODE=sponsor + ENERGY_SOURCE=provider` 使用 `SPONSOR_BANDWIDTH=false`，因此平台不委托 Bandwidth，不需要 signer、资源钱包地址或资源私钥并应保持 `seamless-signer` 停止。允许用户原交易自身燃烧 TRX 不等于平台赞助 Bandwidth：java-tron 会在质押与免费池均无法单独覆盖整笔时收取整笔字节费。
- 资源测试数据只写入按 `tx_id` 一对一的审计表，保存原始/安全估算、计划/实际请求套餐、套餐阈值、资源快照、`fee_limit` 上下界和固化回执白名单指标；供应商订单独立保存成本及安全尝试时间线。不得存完整 receipt、合约返回值、签名原文或任何供应商密钥。
- 账户免费带宽是否最终可用还受全链公共免费池约束，而 `getaccountresource` 不提供该池的可靠剩余量。审计中的来源仍可标为 `FREE`，但 `estimated_bandwidth_burn_sun` 必须记录公共池不足时整笔燃烧 TRX 的最坏值，并在供应商外呼前通过用户燃烧开关、上限和余额校验；只有完整的质押带宽桶可按零燃烧处理。
- 任何付费供应商外呼前都必须再次验证 TAPOS，并分别查询 FullNode 的已入链交易库和 pending pool；发现相同 txID 或任一查询不可用时闭合拒绝。签名交易还必须没有 `Transaction.ret`，其 `raw_data` 以及受支持合约的 `Any.value` 必须分别与 java-tron 解码后重新编码的规范字节完全一致，并在 java-tron 的 500 KiB 上限内预留执行结果空间。该检查只能减少“先直连节点广播、再请求能量”的风险，无法消除检查后并发直连广播的竞态；生产网络仍应将可广播入口限定为网关或受信任客户端。
- 网关只把精确的 `/protocol.Wallet/BroadcastTransaction` 交给广播策略引擎。其余方法必须精确命中按当前 java-tron `v4.8.2.1/f8b05d40` 完整 proto 固定的查询/未签名交易构造白名单；未知、大小写变化、query、尾斜线、双斜线、百分号编码和畸形路径均不会代理到 FullNode。疑似交易提交返回 gRPC `PERMISSION_DENIED`，其他未知方法返回 `UNIMPLEMENTED`。升级节点前必须重新审核并更新白名单。它不能阻止钱包自行回退到其他公网节点或局域网客户端直连 `{FULLNODE_IP}`。
- 赞助广播在任何数据库或供应商动作前只接受 `POST` 与 `application/grpc`/`application/grpc+proto`。付费后的上游请求固定重建 `:method`、`:path`、`content-type` 和 `te`，不转发客户端提供的 `grpc-timeout`、压缩或其他控制头，避免供应商已收费后由传输层提前拒绝。
- 一旦供应商订单可能收费，次数与地址锁就切换为不可按普通失败释放的状态。后续状态写入失败只能 best-effort 记录，仍应尝试广播；如果已无法安全广播，则保留为恢复中的请求，禁止缓存为可解锁的 `FAILED`。
- 数据库用于幂等和租约恢复，必须定期备份。部署多实例前要把资源准备锁升级为 PostgreSQL advisory lock；当前版本按单网关实例设计。

## Mainnet 操作原则

- `observe` 只关闭资源准备，不关闭交易广播。TronLink 在 Mainnet 签名并提交后，交易仍可能立即上链并消耗账户资源或 TRX。
- 首次测试只用新建、低余额、已绑定且次数为 1 的地址，发送可承受损失的小额 TRC20 交易。
- API Key、租期、单笔或每日预算属于付费执行参数；供应商处于启用状态时服务端拒绝修改。必须先停用、修改并复核，再单独启用。
- 当前已经部署为 `sponsor + provider`；供应商和绑定是可变运行数据，不能假设为空。每次 Mainnet 测试前确认节点同步、`estimateenergy`、有限次数绑定、供应商启停、当日预算、`ALLOW_OWNER_ENERGY_BURN=false` 以及 Bandwidth 燃烧上限，只查看一笔完整订单，不进行并发压测。
- `UNKNOWN` 或确认超时期间禁止重新构造和发送另一笔等价交易，先人工确认是否已租到 ENERGY、是否已经扣费以及原交易是否广播。
