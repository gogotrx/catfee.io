(function () {
  "use strict";

  const REQUEST_LIMIT = 50;
  const PROVIDER_LIMIT_DEFAULTS = {
    maxEnergyPerOrder: "131000",
    dailyOrderLimit: "10",
    dailyEnergyLimit: "1000000"
  };
  const PROVIDER_LIMIT_MAXIMUMS = {
    maxEnergyPerOrder: "10000000",
    dailyOrderLimit: "1000000",
    dailyEnergyLimit: "1000000000000"
  };

  const state = {
    token: "",
    status: null,
    bindings: [],
    requests: [],
    providers: [],
    providerOrders: [],
    providerSnapshots: new Map(),
    providerSnapshotErrors: new Map(),
    providerSnapshotRequests: new Set(),
    selectedProviderId: "",
    editingAddress: null,
    resetAddress: null,
    resetBinding: null,
    resetBlockingProviderOrder: null,
    editingProviderId: null,
    refreshTimer: null,
    refreshing: false,
    sessionGeneration: 0,
    sessionController: null
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    bindEvents();
    syncLimitField(elements.bindingLimitMode, elements.bindingLimitField, elements.bindingLimit);
    syncLimitField(elements.resetLimitMode, elements.resetLimitField, elements.resetLimit);
    setRefreshTimer();

    if (state.token) {
      elements.loginScreen.hidden = true;
      void refreshAll({ initial: true });
    } else {
      showLogin();
    }
  }

  function cacheElements() {
    const ids = [
      "login-screen", "login-form", "token-input", "toggle-token-button", "login-error", "login-button",
      "logout-button", "refresh-button", "refresh-interval", "connection-pill", "connection-text",
      "observe-warning", "observe-warning-title", "observe-warning-text", "metric-mode", "metric-mode-detail", "metric-gateway", "metric-gateway-detail",
      "metric-updated", "metric-updated-detail", "metric-bindings", "metric-bindings-detail",
      "add-binding-button", "binding-search", "binding-summary", "bindings-body", "bindings-empty",
      "requests-body", "requests-empty", "request-count", "binding-dialog", "binding-form",
      "binding-dialog-title", "binding-address", "binding-label", "binding-limit-mode", "binding-limit-field",
      "binding-limit", "binding-unlimited-option", "binding-paid-quota-notice", "binding-expires", "binding-enabled", "binding-form-error", "binding-save-button",
      "reset-dialog", "reset-form", "reset-address", "reset-limit-mode", "reset-limit-field", "reset-limit",
      "reset-unlimited-option", "reset-paid-quota-notice", "reset-form-error", "reset-save-button", "reset-current-used", "reset-current-reserved", "reset-current-max",
      "reset-open-order-warning",
      "add-provider-button", "providers-grid", "providers-empty", "provider-order-filter", "provider-orders-body",
      "provider-orders-empty", "provider-dialog", "provider-form", "provider-dialog-title", "provider-type",
      "provider-name", "provider-priority", "provider-rent-time", "provider-api-key", "provider-api-key-required",
      "provider-max-energy-per-order", "provider-daily-order-limit", "provider-daily-energy-limit",
      "provider-api-key-help", "provider-enabled", "provider-form-error", "provider-save-button",
      "provider-budget-window", "provider-budget-used-orders", "provider-budget-order-limit", "provider-budget-remaining-orders",
      "provider-budget-used-energy", "provider-budget-energy-limit", "provider-budget-remaining-energy",
      "provider-budget-per-order", "provider-budget-orders-bar", "provider-budget-energy-bar", "toast-region"
    ];

    for (const id of ids) {
      const camelName = id.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      elements[camelName] = document.getElementById(id);
    }
  }

  function bindEvents() {
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.toggleTokenButton.addEventListener("click", toggleTokenVisibility);
    elements.logoutButton.addEventListener("click", logout);
    elements.refreshButton.addEventListener("click", () => void refreshAll());
    elements.refreshInterval.addEventListener("change", setRefreshTimer);
    elements.bindingSearch.addEventListener("input", renderBindings);
    elements.addBindingButton.addEventListener("click", () => openBindingDialog());
    elements.bindingLimitMode.addEventListener("change", () => {
      syncLimitField(elements.bindingLimitMode, elements.bindingLimitField, elements.bindingLimit);
    });
    elements.resetLimitMode.addEventListener("change", () => {
      syncLimitField(elements.resetLimitMode, elements.resetLimitField, elements.resetLimit);
    });
    elements.bindingForm.addEventListener("submit", handleBindingSave);
    elements.resetForm.addEventListener("submit", handleResetSave);
    elements.addProviderButton.addEventListener("click", () => openProviderDialog());
    elements.providerForm.addEventListener("submit", handleProviderSave);
    elements.providerOrderFilter.addEventListener("change", () => {
      state.selectedProviderId = elements.providerOrderFilter.value;
      renderProviderOrders();
    });

    document.querySelectorAll(".modal-close").forEach((button) => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
    elements.providerDialog.addEventListener("close", clearProviderSecret);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearRefreshTimer();
      else {
        setRefreshTimer();
        if (state.token) void refreshAll();
      }
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const token = elements.tokenInput.value.trim();
    if (!token) return;
    elements.tokenInput.value = "";

    setFormError(elements.loginError, "");
    setButtonBusy(elements.loginButton, true, "正在验证…");
    state.sessionController?.abort();
    const generation = ++state.sessionGeneration;
    const controller = new AbortController();
    state.sessionController = controller;
    state.token = token;

    try {
      const status = await api("/v1/status", { signal: controller.signal });
      if (!isCurrentSession(generation, token)) return;
      state.status = status;
      elements.loginScreen.hidden = true;
      await refreshAll({ statusAlreadyLoaded: true, generation, token });
      if (!isCurrentSession(generation, token)) return;
      setRefreshTimer();
      showToast("连接成功", "管理后台已完成身份验证。");
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentSession(generation, token)) return;
      const message = friendlyError(error, "无法连接管理后台");
      clearSessionState();
      showLogin();
      setFormError(elements.loginError, message);
    } finally {
      if (isCurrentSession(generation, token)) {
        setButtonBusy(elements.loginButton, false, "安全连接");
      }
    }
  }

  function toggleTokenVisibility() {
    const revealing = elements.tokenInput.type === "password";
    elements.tokenInput.type = revealing ? "text" : "password";
    elements.toggleTokenButton.setAttribute("aria-label", revealing ? "隐藏 Token" : "显示 Token");
  }

  function logout() {
    clearSessionState();
    showLogin();
  }

  function clearSessionState() {
    state.sessionGeneration += 1;
    state.sessionController?.abort();
    state.sessionController = null;
    state.refreshing = false;
    state.token = "";
    state.status = null;
    state.bindings = [];
    state.requests = [];
    state.providers = [];
    state.providerOrders = [];
    state.providerSnapshots.clear();
    state.providerSnapshotErrors.clear();
    state.providerSnapshotRequests.clear();
    state.selectedProviderId = "";
    state.editingAddress = null;
    state.resetAddress = null;
    state.resetBinding = null;
    state.resetBlockingProviderOrder = null;
    state.editingProviderId = null;
    elements.tokenInput.value = "";
    setButtonBusy(elements.loginButton, false, "安全连接");
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove("is-spinning");
    clearProviderSecret();
    clearRefreshTimer();
    [elements.bindingDialog, elements.resetDialog, elements.providerDialog].forEach((dialog) => {
      if (dialog.open) dialog.close();
    });
    renderBindings();
    renderProviders();
    renderProviderOrders();
    renderRequests();
    renderStatus();
  }

  function showLogin() {
    elements.loginScreen.hidden = false;
    elements.tokenInput.type = "password";
    setConnection("offline", "未连接");
    window.setTimeout(() => elements.tokenInput.focus(), 0);
  }

  function isCurrentSession(generation, token) {
    return generation === state.sessionGeneration && token === state.token;
  }

  async function refreshAll(options) {
    const generation = options?.generation ?? state.sessionGeneration;
    const token = options?.token ?? state.token;
    if (!token || !isCurrentSession(generation, token) || state.refreshing) return;
    state.refreshing = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add("is-spinning");
    setConnection("loading", "正在刷新");

    try {
      const statusPromise = options?.statusAlreadyLoaded
        ? Promise.resolve(state.status)
        : api("/v1/status", { signal: state.sessionController?.signal });
      const [status, bindingsPayload, requestsPayload, providersPayload, providerOrdersPayload] = await Promise.all([
        statusPromise,
        api("/v1/bindings", { signal: state.sessionController?.signal }),
        api(`/v1/requests?limit=${REQUEST_LIMIT}`, { signal: state.sessionController?.signal }),
        api("/v1/providers", { signal: state.sessionController?.signal }),
        api(`/v1/provider-orders?limit=${REQUEST_LIMIT}`, { signal: state.sessionController?.signal })
      ]);

      if (!isCurrentSession(generation, token)) return;
      state.status = status || state.status || {};
      state.bindings = extractArray(bindingsPayload, "bindings");
      state.requests = extractArray(requestsPayload, "requests");
      state.providers = extractArray(providersPayload, "providers");
      const providerOrders = extractArray(providerOrdersPayload, "orders");
      state.providerOrders = providerOrders.length
        ? providerOrders
        : extractArray(providerOrdersPayload, "providerOrders");
      renderStatus();
      renderBindings();
      renderProviders();
      renderProviderOrders();
      renderRequests();
      setConnection("online", "连接正常");
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentSession(generation, token)) {
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        clearSessionState();
        showLogin();
        setFormError(elements.loginError, "Token 已失效，请重新输入。");
      } else {
        setConnection("offline", "刷新失败");
        showToast("刷新失败", friendlyError(error, "无法读取网关状态"), true);
      }
    } finally {
      if (isCurrentSession(generation, token)) {
        state.refreshing = false;
        elements.refreshButton.disabled = false;
        elements.refreshButton.classList.remove("is-spinning");
      }
    }
  }

  function renderStatus() {
    const status = state.status || {};
    const rawMode = firstValue(status.gateway?.mode, status.mode, status.gatewayMode, status.runMode, "--");
    const mode = String(rawMode).toLowerCase();
    const modeLabels = { observe: "OBSERVE", sponsor: "SPONSOR", passthrough: "PASSTHROUGH" };
    const modeDetails = {
      observe: "仅观察，不自动委托资源",
      sponsor: "自动委托资源已启用",
      passthrough: "透明转发，不执行赞助"
    };

    setText(elements.metricMode, modeLabels[mode] || String(rawMode).toUpperCase());
    const energySource = status.gateway?.sponsorship?.energySource;
    const baseModeDetail = modeDetails[mode] || "模式由服务端报告";
    setText(elements.metricModeDetail, energySource ? `${baseModeDetail} · ${energySource === "provider" ? "供应商供能" : "自有资源"}` : baseModeDetail);
    const modeKnownNonObserve = mode === "sponsor" || mode === "passthrough";
    elements.observeWarning.hidden = modeKnownNonObserve;
    if (mode === "observe") {
      setText(elements.observeWarningTitle, "当前为 OBSERVE 观察模式");
      setText(elements.observeWarningText, "网关只校验与记录请求，不会自动委托 ENERGY 或 BANDWIDTH。广播仍会提交至 Mainnet，可能产生真实链上交易。");
    } else if (!modeKnownNonObserve) {
      setText(elements.observeWarningTitle, "尚未确认运行模式");
      setText(elements.observeWarningText, "确认服务端状态前，请按无资源赞助处理。广播仍会提交至 Mainnet，可能产生真实链上交易。");
    }

    const readiness = firstValue(status.ready, status.healthy, status.status, status.gateway?.status);
    const nestedReady = status.database?.reachable === true && status.nodes?.fullNode?.reachable === true;
    const ready = nestedReady || readiness === true || ["ready", "ok", "healthy", "online"].includes(String(readiness).toLowerCase());
    setText(elements.metricGateway, ready ? "正常" : readiness ? String(readiness) : state.token ? "已连接" : "--");
    const fullNodeHeight = firstValue(status.nodes?.fullNode?.height, status.nodeHeight);
    const gatewayDetail = ready && fullNodeHeight != null
      ? `FullNode #${formatInteger(fullNodeHeight)} · 数据库正常`
      : ready ? "数据库与上游可用" : "状态已返回";
    setText(
      elements.metricGatewayDetail,
      firstValue(status.nodeStatus, status.upstream?.status, status.node?.status, gatewayDetail)
    );

    const checkedAt = new Date(firstValue(status.checkedAt, Date.now()));
    const safeCheckedAt = Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt;
    setText(elements.metricUpdated, formatTime(safeCheckedAt));
    setText(elements.metricUpdatedDetail, formatDate(safeCheckedAt));

    const enabled = state.bindings.filter((binding) => isBindingUsable(binding)).length;
    setText(elements.metricBindings, formatInteger(state.bindings.length));
    setText(elements.metricBindingsDetail, `${formatInteger(enabled)} 个当前可用`);
    renderProviderBudget(status.energyProviders?.budget);
    applyPaidQuotaPolicy();
  }

  function renderBindings() {
    clearNode(elements.bindingsBody);
    const query = elements.bindingSearch.value.trim().toLowerCase();
    const filtered = state.bindings.filter((binding) => {
      if (!query) return true;
      return String(binding.address || "").toLowerCase().includes(query) ||
        String(binding.label || "").toLowerCase().includes(query);
    });

    for (const binding of filtered) {
      elements.bindingsBody.appendChild(createBindingRow(binding));
    }

    elements.bindingsEmpty.hidden = filtered.length !== 0;
    const suffix = query ? `，筛选后 ${filtered.length} 个` : "";
    setText(elements.bindingSummary, `共 ${state.bindings.length} 个地址${suffix}`);

    const enabled = state.bindings.filter((binding) => isBindingUsable(binding)).length;
    setText(elements.metricBindings, formatInteger(state.bindings.length));
    setText(elements.metricBindingsDetail, `${formatInteger(enabled)} 个当前可用`);
  }

  function createBindingRow(binding) {
    const row = document.createElement("tr");
    const address = String(binding.address || "");

    const identityCell = createCell("地址 / 备注", "primary-cell");
    const addressText = document.createElement("strong");
    addressText.textContent = address || "未知地址";
    addressText.title = address;
    const label = document.createElement("small");
    label.textContent = binding.label || "未填写备注";
    identityCell.append(addressText, label);

    const statusCell = createCell("状态");
    const expired = isExpired(binding.expiresAt);
    const usable = binding.enabled !== false && !expired;
    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${usable ? "badge-success" : expired ? "badge-danger" : "badge-neutral"}`;
    statusBadge.textContent = usable ? "已启用" : expired ? "已过期" : "已停用";
    statusCell.appendChild(statusBadge);

    const quotaCell = createCell("次数", "quota");
    const used = integerString(binding.usedTransactions, "0");
    const reserved = integerString(binding.reservedTransactions, "0");
    const maximum = nullableInteger(binding.maxTransactions);
    const values = document.createElement("div");
    values.className = "quota-values";
    const usedLabel = document.createElement("span");
    usedLabel.textContent = `已用 ${formatInteger(used)}`;
    const maximumLabel = document.createElement("span");
    maximumLabel.textContent = maximum === null ? "不限" : `/ ${formatInteger(maximum)}`;
    values.append(usedLabel, maximumLabel);
    quotaCell.appendChild(values);
    if (maximum !== null) {
      const track = document.createElement("div");
      track.className = "quota-track";
      const bar = document.createElement("span");
      const percent = percentage(used, reserved, maximum);
      const widthBucket = Math.max(0, Math.min(10, Math.ceil(percent / 10)));
      bar.className = `quota-bar quota-width-${widthBucket}${percent >= 100 ? " is-full" : percent >= 80 ? " is-near" : ""}`;
      track.title = reserved !== "0" ? `另有 ${reserved} 次处理中` : `${percent}%`;
      track.appendChild(bar);
      quotaCell.appendChild(track);
    } else if (reserved !== "0") {
      const reservedLabel = document.createElement("small");
      reservedLabel.textContent = `${formatInteger(reserved)} 次处理中`;
      quotaCell.appendChild(reservedLabel);
    }

    const expiryCell = createCell("有效期");
    if (binding.expiresAt) {
      const expiry = document.createElement("span");
      expiry.textContent = formatDateTime(binding.expiresAt);
      if (expired) expiry.className = "expired-text";
      expiryCell.appendChild(expiry);
    } else {
      expiryCell.textContent = "长期有效";
    }

    const actionCell = createCell("操作");
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const editButton = createActionButton("编辑", () => openBindingDialog(binding));
    const resetButton = createActionButton("重置次数", () => openResetDialog(binding));
    const toggleButton = createActionButton(binding.enabled === false ? "启用" : "停用", () => {
      void toggleBinding(binding, toggleButton);
    });
    if (binding.enabled !== false) toggleButton.classList.add("is-danger");
    actions.append(editButton, resetButton, toggleButton);
    actionCell.appendChild(actions);

    row.append(identityCell, statusCell, quotaCell, expiryCell, actionCell);
    return row;
  }

  function renderRequests() {
    clearNode(elements.requestsBody);
    for (const request of state.requests) {
      elements.requestsBody.appendChild(createRequestRow(request));
    }
    elements.requestsEmpty.hidden = state.requests.length !== 0;
    setText(elements.requestCount, `${state.requests.length} 条`);
  }

  function createRequestRow(request) {
    const row = document.createElement("tr");
    const txId = String(firstValue(request.txId, request.tx_id) ?? "");
    const owner = String(firstValue(request.ownerAddress, request.owner_address) ?? "");
    const audit = request.audit && typeof request.audit === "object" ? request.audit : {};

    const identityCell = createCell("交易 / 地址", "primary-cell");
    const tx = document.createElement("strong");
    tx.textContent = shorten(txId, 12, 8) || "未知交易";
    tx.title = txId;
    const ownerText = document.createElement("small");
    ownerText.textContent = owner ? `发起方 ${shorten(owner, 8, 6)}` : "发起方未知";
    ownerText.title = owner;
    identityCell.append(tx, ownerText);

    const stateCell = createCell("状态");
    const requestState = String(firstValue(request.state, "UNKNOWN"));
    const badge = document.createElement("span");
    badge.className = `badge ${requestStateClass(requestState)}`;
    badge.textContent = requestStateLabel(requestState);
    badge.title = requestState;
    stateCell.appendChild(badge);
    const errorCode = firstValue(request.errorCode, request.error_code);
    const errorMessage = firstValue(request.errorMessage, request.error_message);
    if (errorCode) {
      const errorCodeText = document.createElement("small");
      errorCodeText.className = "error-code";
      errorCodeText.textContent = `错误码：${String(errorCode)}`;
      stateCell.appendChild(errorCodeText);
    }
    if (errorMessage) {
      const errorMessageText = document.createElement("small");
      errorMessageText.className = "error-code";
      errorMessageText.textContent = `原因：${String(errorMessage)}`;
      stateCell.appendChild(errorMessageText);
    }

    const energyCell = createCell("能量预估", "resource-cell");
    const energyRaw = audit.energyEstimateRaw;
    const energySafe = firstValue(audit.energyEstimateSafe, request.energyRequired, request.energy_required);
    const energyBefore = audit.energyAvailableBefore;
    const energyAfter = audit.energyAvailableAfter;
    const energyDelta = audit.energyArrivalDelta;
    appendCompactAudit(
      energyCell,
      `原始 ${formatAuditInteger(energyRaw)} · 安全 ${formatAuditInteger(energySafe)}`,
      [
        `套餐 计划 ${formatAuditInteger(audit.energyPackageQuoted)} · 已请求 ${formatAuditInteger(audit.energyPackageAttempted)}`,
        `可用 ${formatAuditInteger(energyBefore)} → ${formatAuditInteger(energyAfter)}（${formatSignedAuditInteger(energyDelta)}）`,
        `预估能量燃烧 ${formatSunAsTrx(audit.estimatedEnergyBurnSun)}`
      ]
    );
    energyCell.title = auditTooltip([
      ["原始 Energy 估算", formatAuditUnit(energyRaw, "ENERGY")],
      ["安全 Energy 估算", formatAuditUnit(energySafe, "ENERGY")],
      ["估算安全系数", formatBasisPoints(audit.estimateSafetyBps)],
      ["交易前可用 Energy", formatAuditUnit(energyBefore, "ENERGY")],
      ["套餐判断阈值", formatAuditUnit(audit.packageThreshold, "ENERGY")],
      ["计划 Energy 套餐", formatAuditUnit(audit.energyPackageQuoted, "ENERGY")],
      ["实际请求 Energy 套餐", formatAuditUnit(audit.energyPackageAttempted, "ENERGY")],
      ["Energy 单价", formatAuditUnit(audit.energyPriceSun, "SUN")],
      ["预估 Energy 燃烧", formatSunDetail(audit.estimatedEnergyBurnSun)],
      ["到账后可用 Energy", formatAuditUnit(energyAfter, "ENERGY")],
      ["Energy 到账增量", formatAuditUnit(energyDelta, "ENERGY")],
      ["交易 fee_limit", formatSunDetail(audit.feeLimitSun)],
      ["安全执行所需最低 fee_limit", formatSunDetail(audit.minimumFeeLimitSun)],
      ["当前链上最高 fee_limit", formatSunDetail(audit.maximumFeeLimitSun)]
    ]);

    const bandwidthCell = createCell("带宽预检", "resource-cell");
    const bandwidthBytes = firstValue(audit.bandwidthBytes, request.bandwidthRequired, request.bandwidth_required);
    appendCompactAudit(
      bandwidthCell,
      `${bandwidthSourceLabel(audit.bandwidthSource)} · ${formatAuditInteger(bandwidthBytes)} Bytes`,
      [
        `质押 ${formatAuditInteger(audit.bandwidthStakedAvailable)} · 免费 ${formatAuditInteger(audit.bandwidthFreeAvailable)}`,
        `最坏燃烧 ${formatSunAsTrx(audit.estimatedBandwidthBurnSun)}`
      ]
    );
    bandwidthCell.title = auditTooltip([
      ["带宽来源", bandwidthSourceLabel(audit.bandwidthSource)],
      ["交易带宽", formatAuditUnit(bandwidthBytes, "Bytes")],
      ["可用质押带宽", formatAuditUnit(audit.bandwidthStakedAvailable, "Bandwidth")],
      ["可用免费带宽", formatAuditUnit(audit.bandwidthFreeAvailable, "Bandwidth")],
      ["带宽单价", formatAuditUnit(audit.bandwidthUnitPriceSun, "SUN/Byte")],
      ["最坏情况带宽燃烧", formatSunDetail(audit.estimatedBandwidthBurnSun)],
      ["用户余额", formatSunDetail(audit.ownerBalanceSun)]
    ]);

    const receiptCell = createCell("链上实绩", "resource-cell");
    const receiptTotalEnergy = audit.receiptEnergyUsageTotal;
    const receiptResult = firstValue(audit.receiptResult, "等待固化");
    appendCompactAudit(
      receiptCell,
      `实际 Energy ${formatAuditInteger(receiptTotalEnergy)} · ${receiptResultLabel(receiptResult)}`,
      [
        `用户 ${formatAuditInteger(audit.receiptEnergyUsage)} · 合约方 ${formatAuditInteger(audit.receiptOriginEnergyUsage)}`,
        `总费 ${formatSunAsTrx(audit.receiptTotalFeeSun)}（能量 ${formatSunAsTrx(audit.receiptEnergyFeeSun)} / 带宽 ${formatSunAsTrx(audit.receiptNetFeeSun)}）`,
        `固化 ${audit.solidifiedAt ? formatDateTime(audit.solidifiedAt) : "--"}`
      ]
    );
    receiptCell.title = auditTooltip([
      ["回执结果", receiptResultLabel(receiptResult)],
      ["总 Energy 消耗", formatAuditUnit(receiptTotalEnergy, "ENERGY")],
      ["用户 Energy 消耗", formatAuditUnit(audit.receiptEnergyUsage, "ENERGY")],
      ["合约方 Energy 消耗", formatAuditUnit(audit.receiptOriginEnergyUsage, "ENERGY")],
      ["带宽消耗", formatAuditUnit(audit.receiptNetUsage, "Bandwidth")],
      ["带宽费", formatSunDetail(audit.receiptNetFeeSun)],
      ["Energy 费", formatSunDetail(audit.receiptEnergyFeeSun)],
      ["总手续费", formatSunDetail(audit.receiptTotalFeeSun)],
      ["固化时间", audit.solidifiedAt ? formatDateTime(audit.solidifiedAt) : "--"]
    ]);

    const updatedCell = createCell("更新时间");
    const updated = firstValue(request.updatedAt, request.updated_at, request.createdAt, request.created_at);
    updatedCell.textContent = updated ? formatDateTime(updated) : "--";

    row.append(identityCell, stateCell, energyCell, bandwidthCell, receiptCell, updatedCell);
    return row;
  }

  function appendCompactAudit(cell, primary, details) {
    const content = document.createElement("div");
    const primaryLine = document.createElement("span");
    primaryLine.textContent = primary;
    const detailLines = document.createElement("small");
    details.forEach((detail, index) => {
      if (index > 0) detailLines.appendChild(document.createElement("br"));
      detailLines.appendChild(document.createTextNode(detail));
    });
    content.append(primaryLine, detailLines);
    cell.appendChild(content);
  }

  function auditTooltip(entries) {
    return entries.map(([label, value]) => `${label}：${value}`).join("\n");
  }

  function formatAuditInteger(value) {
    return value === undefined || value === null || value === "" ? "--" : formatInteger(value);
  }

  function formatSignedAuditInteger(value) {
    if (value === undefined || value === null || value === "") return "--";
    const text = String(value);
    return text.startsWith("-") ? formatInteger(text) : `+${formatInteger(text)}`;
  }

  function formatAuditUnit(value, unit) {
    const formatted = formatAuditInteger(value);
    return formatted === "--" ? formatted : `${formatted} ${unit}`;
  }

  function formatBasisPoints(value) {
    if (value === undefined || value === null || value === "") return "--";
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${(numeric / 100).toFixed(2).replace(/\.00$/, "")} %` : String(value);
  }

  function formatSunAsTrx(value) {
    if (value === undefined || value === null || value === "") return "--";
    const text = String(value);
    if (!/^\d+$/.test(text)) return `${text} SUN`;
    try {
      const sun = BigInt(text);
      const whole = sun / 1_000_000n;
      const fraction = String(sun % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
      return `${formatInteger(whole)}${fraction ? `.${fraction}` : ""} TRX`;
    } catch (_error) {
      return `${text} SUN`;
    }
  }

  function formatSunDetail(value) {
    const formatted = formatAuditInteger(value);
    return formatted === "--" ? formatted : `${formatSunAsTrx(value)}（${formatted} SUN）`;
  }

  function bandwidthSourceLabel(value) {
    if (value === undefined || value === null || value === "") return "来源待定";
    const source = String(value).toUpperCase();
    const labels = {
      STAKED: "质押带宽",
      FREE: "免费带宽",
      STAKED_AND_FREE: "质押 + 免费",
      STAKED_AND_TRX: "质押带宽 + TRX",
      FREE_AND_TRX: "免费带宽 + TRX",
      STAKED_FREE_AND_TRX: "质押 + 免费 + TRX",
      BANDWIDTH_AND_TRX: "带宽 + TRX",
      TRX: "TRX",
      NONE: "无"
    };
    return labels[source] || String(value);
  }

  function receiptResultLabel(value) {
    const result = String(value ?? "");
    const labels = {
      SUCCESS: "成功",
      SUCESS: "成功",
      FAILED: "失败",
      REVERT: "回滚",
      OUT_OF_ENERGY: "Energy 不足"
    };
    return labels[result.toUpperCase()] || result || "等待固化";
  }

  function openBindingDialog(binding) {
    state.editingAddress = binding?.address || null;
    setText(elements.bindingDialogTitle, binding ? "编辑绑定地址" : "添加绑定地址");
    elements.bindingAddress.value = binding?.address || "";
    elements.bindingAddress.readOnly = Boolean(binding);
    elements.bindingLabel.value = binding?.label || "";
    elements.bindingEnabled.checked = binding?.enabled !== false;

    const maximum = binding ? nullableInteger(binding.maxTransactions) : "10";
    const paidProviderMode = isPaidProviderMode();
    elements.bindingLimitMode.value = maximum === null && !paidProviderMode ? "unlimited" : "limited";
    elements.bindingLimit.value = maximum === null ? (paidProviderMode && binding ? "" : "10") : maximum;
    applyPaidQuotaPolicy();
    syncLimitField(elements.bindingLimitMode, elements.bindingLimitField, elements.bindingLimit);
    elements.bindingExpires.value = binding?.expiresAt ? toLocalDateTimeInput(binding.expiresAt) : "";
    setFormError(elements.bindingFormError, "");
    elements.bindingDialog.showModal();
    window.setTimeout(() => (binding ? elements.bindingLabel : elements.bindingAddress).focus(), 0);
  }

  async function handleBindingSave(event) {
    event.preventDefault();
    setFormError(elements.bindingFormError, "");

    const address = elements.bindingAddress.value.trim();
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
      setFormError(elements.bindingFormError, "请输入有效的 T 开头 TRON Base58 地址。");
      elements.bindingAddress.focus();
      return;
    }

    const limited = elements.bindingLimitMode.value === "limited";
    const maximum = elements.bindingLimit.value.trim();
    if (limited && !isNonNegativeInteger(maximum)) {
      setFormError(elements.bindingFormError, "次数必须是大于或等于 0 的整数。");
      elements.bindingLimit.focus();
      return;
    }
    if (isPaidProviderMode() && !limited) {
      setFormError(elements.bindingFormError, "外部供应商付费赞助模式必须设置有限总次数。");
      return;
    }

    let expiresAt = null;
    if (elements.bindingExpires.value) {
      const date = new Date(elements.bindingExpires.value);
      if (Number.isNaN(date.getTime())) {
        setFormError(elements.bindingFormError, "到期时间格式无效。");
        elements.bindingExpires.focus();
        return;
      }
      expiresAt = date.toISOString();
    }

    const payload = {
      address,
      label: elements.bindingLabel.value.trim() || null,
      maxTransactions: limited ? maximum : null,
      expiresAt,
      enabled: elements.bindingEnabled.checked
    };

    setButtonBusy(elements.bindingSaveButton, true, "正在保存…");
    try {
      await api("/v1/bindings", { method: "POST", body: payload });
      elements.bindingDialog.close();
      showToast("保存成功", state.editingAddress ? "地址规则已更新。" : "地址已加入授权列表。");
      await refreshAll();
    } catch (error) {
      setFormError(elements.bindingFormError, friendlyError(error, "保存地址失败"));
    } finally {
      setButtonBusy(elements.bindingSaveButton, false, "保存地址");
    }
  }

  async function toggleBinding(binding, button) {
    const address = String(binding.address || "");
    const enabled = binding.enabled === false;
    if (!enabled && !window.confirm(`确定停用地址 ${shorten(address, 8, 6)} 吗？`)) return;

    setButtonBusy(button, true, enabled ? "启用中…" : "停用中…");
    try {
      await api(`/v1/bindings/${encodeURIComponent(address)}`, {
        method: "PATCH",
        body: { enabled }
      });
      showToast(enabled ? "地址已启用" : "地址已停用", shorten(address, 10, 8));
      await refreshAll();
    } catch (error) {
      showToast("操作失败", friendlyError(error, "无法修改地址状态"), true);
    } finally {
      setButtonBusy(button, false, enabled ? "启用" : "停用");
    }
  }

  function openResetDialog(binding) {
    state.resetAddress = String(binding.address || "");
    state.resetBinding = binding;
    setText(elements.resetAddress, state.resetAddress);
    const maximum = nullableInteger(binding.maxTransactions);
    setText(elements.resetCurrentUsed, formatInteger(integerString(binding.usedTransactions, "0")));
    setText(elements.resetCurrentReserved, formatInteger(integerString(binding.reservedTransactions, "0")));
    setText(elements.resetCurrentMax, maximum === null ? "不限" : formatInteger(maximum));
    const paidProviderMode = isPaidProviderMode();
    state.resetBlockingProviderOrder = paidProviderMode
      ? findBlockingProviderOrder(state.resetAddress)
      : null;
    elements.resetLimitMode.value = maximum === null && !paidProviderMode ? "unlimited" : "limited";
    elements.resetLimit.value = maximum === null ? (paidProviderMode ? "" : "10") : maximum;
    applyPaidQuotaPolicy();
    syncLimitField(elements.resetLimitMode, elements.resetLimitField, elements.resetLimit);
    const blockingState = String(firstValue(
      state.resetBlockingProviderOrder?.state,
      state.resetBlockingProviderOrder?.status,
      ""
    )).toUpperCase();
    elements.resetOpenOrderWarning.hidden = !state.resetBlockingProviderOrder;
    setText(
      elements.resetOpenOrderWarning,
      state.resetBlockingProviderOrder
        ? blockingState === "UNKNOWN"
          ? "检测到该地址存在 UNKNOWN 供应商订单：结果可能已扣费，禁止重置。请先人工核对供应商后台和链上资源。"
          : `检测到该地址存在 ${blockingState || "未完成"} 供应商订单，禁止重置付费次数。`
        : ""
    );
    elements.resetSaveButton.disabled = Boolean(state.resetBlockingProviderOrder);
    setFormError(elements.resetFormError, "");
    elements.resetDialog.showModal();
  }

  async function handleResetSave(event) {
    event.preventDefault();
    setFormError(elements.resetFormError, "");
    const limited = elements.resetLimitMode.value === "limited";
    const maximum = elements.resetLimit.value.trim();
    if (limited && !isNonNegativeInteger(maximum)) {
      setFormError(elements.resetFormError, "次数必须是大于或等于 0 的整数。");
      elements.resetLimit.focus();
      return;
    }
    if (isPaidProviderMode() && !limited) {
      setFormError(elements.resetFormError, "外部供应商付费赞助模式必须设置有限总次数。");
      return;
    }
    if (state.resetBlockingProviderOrder) {
      setFormError(elements.resetFormError, "该地址仍有进行中或 UNKNOWN 供应商订单，禁止重置付费次数。请先人工核对。");
      return;
    }

    const currentUsed = formatInteger(integerString(state.resetBinding?.usedTransactions, "0"));
    const confirmation = isPaidProviderMode()
      ? `再次确认：将 ${shorten(state.resetAddress, 8, 6)} 的已用 ${currentUsed} 次归零。历史供应商扣费不会撤销；归零后该地址可再次产生最多 ${formatInteger(maximum)} 个付费订单。`
      : `再次确认：将 ${shorten(state.resetAddress, 8, 6)} 的已用 ${currentUsed} 次归零并应用新的次数上限？`;
    if (!window.confirm(confirmation)) {
      return;
    }

    setButtonBusy(elements.resetSaveButton, true, "正在重置…");
    try {
      await api(`/v1/bindings/${encodeURIComponent(state.resetAddress)}/reset`, {
        method: "POST",
        body: { maxTransactions: limited ? maximum : null }
      });
      elements.resetDialog.close();
      showToast("次数已重置", "已用次数已归零，新上限已生效。");
      await refreshAll();
    } catch (error) {
      const fallback = error instanceof ApiError && error.status === 409
        ? "存在进行中的预留交易，请稍后再试。"
        : "重置次数失败";
      setFormError(elements.resetFormError, friendlyError(error, fallback));
    } finally {
      setButtonBusy(elements.resetSaveButton, false, "确认重置");
    }
  }

  function renderProviders() {
    clearNode(elements.providersGrid);
    for (const provider of state.providers) {
      elements.providersGrid.appendChild(createProviderCard(provider));
    }
    elements.providersEmpty.hidden = state.providers.length !== 0;
    syncProviderOrderFilter();
  }

  function renderProviderBudget(budget) {
    const windowLabel = budget?.window === "UTC_DAY" ? "UTC 自然日" : budget?.window || "预算未加载";
    setText(elements.providerBudgetWindow, windowLabel);
    const usedOrders = nullableInteger(budget?.usedOrders);
    const orderLimit = nullableInteger(budget?.dailyOrderLimit);
    const remainingOrders = nullableInteger(budget?.remainingOrders);
    const usedEnergy = nullableInteger(budget?.usedEnergy);
    const energyLimit = nullableInteger(budget?.dailyEnergyLimit);
    const remainingEnergy = nullableInteger(budget?.remainingEnergy);
    const perOrder = nullableInteger(budget?.maxEnergyPerOrder);
    setText(elements.providerBudgetUsedOrders, usedOrders === null ? "--" : formatInteger(usedOrders));
    setText(elements.providerBudgetOrderLimit, orderLimit === null ? "--" : formatInteger(orderLimit));
    setText(elements.providerBudgetRemainingOrders, remainingOrders === null ? "--" : formatInteger(remainingOrders));
    setText(elements.providerBudgetUsedEnergy, usedEnergy === null ? "--" : formatInteger(usedEnergy));
    setText(elements.providerBudgetEnergyLimit, energyLimit === null ? "--" : formatInteger(energyLimit));
    setText(elements.providerBudgetRemainingEnergy, remainingEnergy === null ? "--" : formatInteger(remainingEnergy));
    setText(elements.providerBudgetPerOrder, perOrder === null ? "--" : formatInteger(perOrder));
    setBudgetBar(elements.providerBudgetOrdersBar, usedOrders, orderLimit);
    setBudgetBar(elements.providerBudgetEnergyBar, usedEnergy, energyLimit);
    elements.providerBudgetRemainingOrders.closest(".budget-item")?.classList.toggle("is-exhausted", remainingOrders === "0");
    elements.providerBudgetRemainingEnergy.closest(".budget-item")?.classList.toggle("is-exhausted", remainingEnergy === "0");
  }

  function setBudgetBar(element, used, limit) {
    const percent = used === null || limit === null ? 0 : percentage(used, "0", limit);
    const bucket = Math.max(0, Math.min(10, Math.ceil(percent / 10)));
    element.className = `quota-bar quota-width-${bucket}${percent >= 100 ? " is-full" : percent >= 80 ? " is-near" : ""}`;
  }

  function createProviderCard(provider) {
    const card = document.createElement("article");
    card.className = "provider-card";
    const providerId = String(provider.id || "");

    const heading = document.createElement("div");
    heading.className = "provider-card-heading";
    const identity = document.createElement("div");
    const type = document.createElement("span");
    type.className = "provider-type";
    type.textContent = providerTypeLabel(provider.type);
    const name = document.createElement("h3");
    name.textContent = String(provider.name || providerTypeLabel(provider.type));
    identity.append(type, name);
    const enabled = provider.enabled !== false;
    const badge = document.createElement("span");
    badge.className = `badge ${enabled ? "badge-success" : "badge-neutral"}`;
    badge.textContent = enabled ? "已启用" : "已停用";
    heading.append(identity, badge);

    const endpoint = document.createElement("div");
    endpoint.className = "provider-endpoint";
    const endpointLabel = document.createElement("span");
    endpointLabel.textContent = "固定 API Endpoint";
    const endpointValue = document.createElement("code");
    endpointValue.textContent = providerTypeLabel(provider.type) === "快租"
      ? "https://api.kuaizu.io/api/rent · /api/balance"
      : "服务端固定 · 网页不可修改";
    endpoint.append(endpointLabel, endpointValue);

    const facts = document.createElement("dl");
    facts.className = "provider-facts";
    appendFact(facts, "优先级", formatInteger(firstValue(provider.priority, 100)));
    appendFact(facts, "租用时长", rentTimeLabel(provider.rentTime));
    if (String(provider.type).toLowerCase() === "kuaizu") {
      appendFact(facts, "固定套餐", "65,000 / 131,000 ENERGY");
      const threshold = state.status?.gateway?.sponsorship?.energyPackageThreshold;
      appendFact(
        facts,
        "当前分档",
        threshold == null ? "未加载" : `< ${formatInteger(threshold)} 使用 65,000`
      );
    }
    appendFact(facts, "单笔上限", `${formatInteger(firstValue(provider.maxEnergyPerOrder, "--"))} ENERGY`);
    appendFact(facts, "每日订单上限", `${formatInteger(firstValue(provider.dailyOrderLimit, "--"))} 单`);
    appendFact(facts, "每日 ENERGY 上限", formatInteger(firstValue(provider.dailyEnergyLimit, "--")));
    appendFact(facts, "API Key", provider.apiKeyConfigured ? "已配置" : "未配置");
    appendFact(facts, "最近更新", formatDateTime(firstValue(provider.updatedAt, provider.updated_at, provider.createdAt, provider.created_at)));

    const budgetSummary = createProviderBudgetSummary(providerId);
    const accountSnapshot = createProviderAccountSnapshot(provider);

    const actions = document.createElement("div");
    actions.className = "provider-actions";
    const ordersButton = createActionButton("查看订单", () => {
      state.selectedProviderId = providerId;
      syncProviderOrderFilter();
      renderProviderOrders();
      elements.providerOrderFilter.focus();
    });
    const editButton = createActionButton("编辑配置", () => openProviderDialog(provider));
    if (enabled) {
      editButton.disabled = true;
      editButton.title = "请先停用供应商，再修改 API Key、租期或预算";
    }
    const toggleButton = createActionButton(enabled ? "停用" : "启用", () => {
      void toggleProvider(provider, toggleButton);
    });
    if (enabled) toggleButton.classList.add("is-danger");
    actions.append(ordersButton, editButton, toggleButton);
    card.append(heading, endpoint, facts, budgetSummary, accountSnapshot, actions);
    return card;
  }

  function createProviderAccountSnapshot(provider) {
    const providerId = String(provider.id || "");
    const snapshot = state.providerSnapshots.get(providerId);
    const error = state.providerSnapshotErrors.get(providerId);
    const pending = state.providerSnapshotRequests.has(providerId);
    const section = document.createElement("section");
    section.className = "provider-account-snapshot";
    section.setAttribute("aria-live", "polite");
    section.setAttribute("aria-busy", String(pending));

    const heading = document.createElement("div");
    heading.className = "provider-snapshot-heading";
    const title = document.createElement("strong");
    title.textContent = "供应商账户快照";
    const queryButton = createActionButton(pending ? "查询中…" : "查询余额/价格", () => {
      void queryProviderAccountSnapshot(provider);
    });
    queryButton.classList.add("provider-snapshot-button");
    queryButton.disabled = pending || !providerId;
    heading.append(title, queryButton);
    section.appendChild(heading);

    if (error) {
      const failure = document.createElement("p");
      failure.className = "provider-snapshot-status is-error";
      failure.textContent = error;
      section.appendChild(failure);
      return section;
    }

    if (!snapshot) {
      const status = document.createElement("p");
      status.className = "provider-snapshot-status";
      status.textContent = pending
        ? "正在向服务端查询供应商账户快照…"
        : "尚未查询。点击按钮后读取余额和参考价格。";
      section.appendChild(status);
      return section;
    }

    const facts = document.createElement("dl");
    facts.className = "provider-snapshot-facts";
    appendFact(facts, `${providerTypeLabel(snapshot.providerType)}余额`, `${formatDecimal(snapshot.balanceTrx)} TRX`);
    appendFact(facts, "参考单价", `${formatDecimal(snapshot.priceSunPerEnergy)} SUN / ENERGY`);
    appendFact(facts, "65,000 参考成本", formatProviderPackageCost(snapshot, "65000"));
    appendFact(facts, "131,000 参考成本", formatProviderPackageCost(snapshot, "131000"));
    appendFact(facts, "查询时间", formatDateTime(snapshot.checkedAt));
    section.appendChild(facts);

    const note = document.createElement("p");
    note.className = "provider-snapshot-note";
    note.textContent = "余额、单价和套餐成本仅供参考；实际扣费以 rent 返回的 orderMoney 为准。";
    section.appendChild(note);
    return section;
  }

  async function queryProviderAccountSnapshot(provider) {
    const providerId = String(provider.id || "");
    if (!providerId || state.providerSnapshotRequests.has(providerId)) return;
    const generation = state.sessionGeneration;
    const token = state.token;
    if (!token || !isCurrentSession(generation, token)) return;

    state.providerSnapshotRequests.add(providerId);
    state.providerSnapshotErrors.delete(providerId);
    renderProviders();
    try {
      const payload = await api(`/v1/providers/${encodeURIComponent(providerId)}/account-snapshot`, {
        method: "POST",
        signal: state.sessionController?.signal
      });
      if (!isCurrentSession(generation, token)) return;
      const snapshot = normalizeProviderAccountSnapshot(payload, providerId, provider.type);
      state.providerSnapshots.set(providerId, snapshot);
      showToast("账户快照已更新", `${providerTypeLabel(snapshot.providerType)}余额和参考价格已读取。`);
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentSession(generation, token)) return;
      const message = friendlyError(error, "无法查询供应商余额和价格");
      state.providerSnapshotErrors.set(providerId, message);
      showToast("查询失败", message, true);
    } finally {
      if (isCurrentSession(generation, token)) {
        state.providerSnapshotRequests.delete(providerId);
        renderProviders();
      }
    }
  }

  function normalizeProviderAccountSnapshot(payload, expectedProviderId, expectedProviderType) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError(502, "invalid_response");
    }
    const providerId = String(payload.providerId ?? "");
    const providerType = String(payload.providerType ?? "").toLowerCase();
    const expectedType = String(expectedProviderType ?? "").toLowerCase();
    const balanceTrx = decimalString(payload.balanceTrx);
    const priceSunPerEnergy = positiveDecimalString(payload.priceSunPerEnergy);
    const checkedAt = String(payload.checkedAt ?? "");
    if (
      providerId !== expectedProviderId
      || !providerType
      || (expectedType && providerType !== expectedType)
      || balanceTrx === null
      || priceSunPerEnergy === null
      || !checkedAt
      || Number.isNaN(new Date(checkedAt).getTime())
      || !Array.isArray(payload.packages)
    ) {
      throw new ApiError(502, "invalid_response");
    }

    const packages = new Map();
    for (const item of payload.packages) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const energy = positiveIntegerString(item.energy);
      const estimatedCostTrx = decimalString(item.estimatedCostTrx);
      if (energy !== null && estimatedCostTrx !== null) packages.set(energy, estimatedCostTrx);
    }
    return { providerId, providerType, balanceTrx, priceSunPerEnergy, packages, checkedAt };
  }

  function formatProviderPackageCost(snapshot, energy) {
    const estimatedCostTrx = snapshot.packages.get(energy);
    return estimatedCostTrx === undefined ? "--" : `${formatDecimal(estimatedCostTrx)} TRX`;
  }

  function createProviderBudgetSummary(providerId) {
    const summary = document.createElement("div");
    summary.className = "provider-card-budget";
    const title = document.createElement("strong");
    title.textContent = "UTC 今日供应商用量";
    summary.appendChild(title);
    const providerBudget = providerBudgetById(providerId);
    if (!providerBudget) {
      const unavailable = document.createElement("small");
      unavailable.textContent = "逐供应商用量暂未加载";
      summary.appendChild(unavailable);
      return summary;
    }
    summary.append(
      createProviderBudgetLine(
        "订单",
        providerBudget.usedOrders,
        providerBudget.dailyOrderLimit,
        providerBudget.remainingOrders,
        "单"
      ),
      createProviderBudgetLine(
        "ENERGY",
        providerBudget.usedEnergy,
        providerBudget.dailyEnergyLimit,
        providerBudget.remainingEnergy,
        "ENERGY"
      )
    );
    return summary;
  }

  function createProviderBudgetLine(label, usedValue, limitValue, remainingValue, unit) {
    const line = document.createElement("div");
    line.className = "provider-budget-line";
    const text = document.createElement("span");
    const used = nullableInteger(usedValue);
    const limit = nullableInteger(limitValue);
    const remaining = nullableInteger(remainingValue);
    text.textContent = `${label}：${used === null ? "--" : formatInteger(used)} / ${limit === null ? "--" : formatInteger(limit)}`;
    const remainingText = document.createElement("small");
    remainingText.textContent = `剩余 ${remaining === null ? "--" : formatInteger(remaining)} ${unit}`;
    const track = document.createElement("div");
    track.className = "quota-track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("i");
    setBudgetBar(bar, used, limit);
    track.appendChild(bar);
    if (remaining === "0") line.classList.add("is-exhausted");
    line.append(text, remainingText, track);
    return line;
  }

  function providerBudgetById(providerId) {
    const budgets = state.status?.energyProviders?.budget?.providers;
    if (!Array.isArray(budgets)) return null;
    return budgets.find((budget) => String(firstValue(budget.providerId, budget.provider_id) ?? "") === providerId) || null;
  }

  function appendFact(list, label, value) {
    const item = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value == null ? "--" : String(value);
    item.append(term, description);
    list.appendChild(item);
  }

  function syncProviderOrderFilter() {
    const previous = state.selectedProviderId;
    clearNode(elements.providerOrderFilter);
    if (state.providers.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无供应商";
      elements.providerOrderFilter.appendChild(option);
      elements.providerOrderFilter.disabled = true;
      state.selectedProviderId = "";
      return;
    }

    elements.providerOrderFilter.disabled = false;
    for (const provider of state.providers) {
      const option = document.createElement("option");
      option.value = String(provider.id || "");
      option.textContent = String(provider.name || providerTypeLabel(provider.type));
      elements.providerOrderFilter.appendChild(option);
    }
    const valid = state.providers.some((provider) => String(provider.id || "") === previous);
    state.selectedProviderId = valid ? previous : String(state.providers[0].id || "");
    elements.providerOrderFilter.value = state.selectedProviderId;
  }

  function renderProviderOrders() {
    clearNode(elements.providerOrdersBody);
    const selected = state.selectedProviderId;
    const orders = state.providerOrders.filter((order) => {
      const providerId = String(firstValue(order.providerId, order.provider_id) ?? "");
      return providerId === selected || (state.providers.length === 1 && !providerId);
    });

    for (const order of orders) {
      elements.providerOrdersBody.appendChild(createProviderOrderRow(order));
    }
    elements.providerOrdersEmpty.hidden = orders.length !== 0;
  }

  function createProviderOrderRow(order) {
    const row = document.createElement("tr");
    const orderId = String(firstValue(order.providerOrderId, order.provider_order_id, order.orderId, order.order_id, order.externalOrderId, order.external_order_id, order.id) ?? "");
    const address = String(firstValue(order.receiveAddress, order.receive_address, order.receiverAddress, order.receiver_address, order.address) ?? "");

    const orderCell = createCell("订单", "primary-cell");
    const orderText = document.createElement("strong");
    orderText.textContent = shorten(orderId, 12, 8) || "未知订单";
    orderText.title = orderId;
    const txId = String(firstValue(order.txId, order.tx_id) ?? "");
    const txText = document.createElement("small");
    txText.textContent = txId ? `交易 ${shorten(txId, 9, 6)}` : "尚无链上交易";
    txText.title = txId;
    const delegationTxHash = String(firstValue(order.delegationTxHash, order.delegation_tx_hash) ?? "");
    const delegationText = document.createElement("small");
    delegationText.textContent = delegationTxHash
      ? `代理 ${shorten(delegationTxHash, 9, 6)}`
      : "代理交易待定";
    delegationText.title = delegationTxHash;
    orderCell.append(orderText, txText, delegationText);

    const addressCell = createCell("接收地址", "primary-cell");
    const addressText = document.createElement("strong");
    addressText.textContent = shorten(address, 9, 7) || "--";
    addressText.title = address;
    const providerBalance = firstValue(order.providerBalanceTrx, order.provider_balance_trx);
    const balanceText = document.createElement("small");
    balanceText.textContent = providerBalance == null
      ? "供应商余额 --"
      : `供应商余额 ${String(providerBalance)} TRX`;
    addressCell.append(addressText, balanceText);

    const resourceCell = createCell("资源 / 数量", "resource-cell");
    const resourceType = String(firstValue(order.resourceType, order.resource_type, "ENERGY"));
    const requestedAmount = firstValue(
      order.requestedAmount,
      order.requested_amount,
      order.requestedEnergyAmount,
      order.requested_energy_amount
    );
    const orderedAmount = Object.hasOwn(order, "orderedAmount")
      ? order.orderedAmount
      : Object.hasOwn(order, "ordered_amount")
        ? order.ordered_amount
        : firstValue(
            order.amount,
            order.energyAmount,
            order.energy_amount,
            order.balanceSun,
            order.balance_sun
          );
    const resource = document.createElement("span");
    resource.textContent = resourceType;
    const amountText = document.createElement("small");
    if (orderedAmount == null) {
      amountText.textContent = requestedAmount == null
        ? "需求 / 套餐 --"
        : `需求 ${formatInteger(requestedAmount)} · 套餐待定`;
    } else if (requestedAmount != null && String(requestedAmount) !== String(orderedAmount)) {
      amountText.textContent = `需求 ${formatInteger(requestedAmount)} · 套餐 ${formatInteger(orderedAmount)}`;
    } else {
      amountText.textContent = `套餐 ${formatInteger(orderedAmount)}`;
    }
    const cost = firstValue(order.orderCostTrx, order.order_cost_trx);
    const rentTime = firstValue(order.rentTime, order.rent_time);
    const costText = document.createElement("small");
    costText.textContent = `时长 ${rentTime == null ? "--" : String(rentTime)} · 成本 ${cost == null ? "--" : String(cost)} TRX`;
    resourceCell.append(resource, amountText, costText);

    const statusCell = createCell("状态");
    const orderStatus = String(firstValue(order.status, order.state, "UNKNOWN"));
    const badge = document.createElement("span");
    badge.className = `badge ${providerOrderStateClass(orderStatus)}`;
    badge.textContent = providerOrderStateLabel(orderStatus);
    badge.title = orderStatus;
    statusCell.appendChild(badge);
    if (orderStatus.toUpperCase() === "UNKNOWN") {
      const warning = document.createElement("small");
      warning.className = "provider-order-warning";
      warning.textContent = "禁止重下单，请人工核对";
      statusCell.appendChild(warning);
    }
    const errorCode = firstValue(order.failureCode, order.failure_code, order.errorCode, order.error_code);
    if (errorCode) {
      const error = document.createElement("small");
      error.className = "error-code";
      error.textContent = `错误码：${String(errorCode)}`;
      statusCell.appendChild(error);
    }
    const attempts = Array.isArray(order.attempts) ? order.attempts : [];
    if (attempts.length > 0) {
      const attemptText = document.createElement("small");
      attemptText.className = "provider-order-warning";
      attemptText.textContent = `${attempts.length} 个供应商阶段（悬停查看）`;
      attemptText.title = attempts.map((attempt) => {
        const provider = firstValue(attempt.providerType, attempt.providerId, "未选供应商");
        const amount = firstValue(attempt.orderedAmount, "--");
        const code = firstValue(attempt.code, "--");
        const at = attempt.at ? formatDateTime(attempt.at) : "--";
        return `${at} · ${provider} · ${attempt.state || "UNKNOWN"} · 套餐 ${formatAuditInteger(amount)} · ${code}`;
      }).join("\n");
      statusCell.appendChild(attemptText);
    }

    const updatedCell = createCell("更新时间");
    const updated = firstValue(order.updatedAt, order.updated_at, order.createdAt, order.created_at);
    updatedCell.textContent = updated ? formatDateTime(updated) : "--";
    row.append(orderCell, addressCell, resourceCell, statusCell, updatedCell);
    return row;
  }

  function openProviderDialog(provider) {
    state.editingProviderId = provider?.id == null ? null : String(provider.id);
    setText(elements.providerDialogTitle, provider ? "编辑能量供应商" : "添加能量供应商");
    elements.providerType.value = String(provider?.type || "kuaizu").toLowerCase();
    elements.providerType.disabled = Boolean(provider);
    elements.providerName.value = String(provider?.name || "快租");
    elements.providerPriority.value = integerString(provider?.priority, "100");
    elements.providerRentTime.value = String(provider?.rentTime) === "1" ? "1" : "15";
    elements.providerMaxEnergyPerOrder.value = integerString(
      provider?.maxEnergyPerOrder,
      PROVIDER_LIMIT_DEFAULTS.maxEnergyPerOrder
    );
    elements.providerDailyOrderLimit.value = integerString(
      provider?.dailyOrderLimit,
      PROVIDER_LIMIT_DEFAULTS.dailyOrderLimit
    );
    elements.providerDailyEnergyLimit.value = integerString(
      provider?.dailyEnergyLimit,
      PROVIDER_LIMIT_DEFAULTS.dailyEnergyLimit
    );
    elements.providerEnabled.checked = provider ? provider.enabled !== false : false;
    elements.providerEnabled.disabled = true;
    elements.providerApiKey.value = "";
    elements.providerApiKey.required = !provider;
    elements.providerApiKeyRequired.hidden = Boolean(provider);
    setText(
      elements.providerApiKeyHelp,
      provider ? "留空表示保留现有 API Key；填写新值将替换，保存后立即清空。" : "新建供应商时必须填写；保存后服务端只返回“已配置”状态。"
    );
    setFormError(elements.providerFormError, "");
    elements.providerDialog.showModal();
    window.setTimeout(() => elements.providerName.focus(), 0);
  }

  async function handleProviderSave(event) {
    event.preventDefault();
    setFormError(elements.providerFormError, "");
    const name = elements.providerName.value.trim();
    const priority = elements.providerPriority.value.trim();
    const maxEnergyPerOrder = elements.providerMaxEnergyPerOrder.value.trim();
    const dailyOrderLimit = elements.providerDailyOrderLimit.value.trim();
    const dailyEnergyLimit = elements.providerDailyEnergyLimit.value.trim();
    const apiKey = elements.providerApiKey.value;
    elements.providerApiKey.value = "";
    if (!name) {
      setFormError(elements.providerFormError, "请输入供应商显示名称。");
      return;
    }
    if (!isNonNegativeInteger(priority)) {
      setFormError(elements.providerFormError, "优先级必须是大于或等于 0 的整数。");
      return;
    }
    const providerLimits = [
      ["单笔 ENERGY 上限", maxEnergyPerOrder, PROVIDER_LIMIT_MAXIMUMS.maxEnergyPerOrder, elements.providerMaxEnergyPerOrder],
      ["每日订单上限", dailyOrderLimit, PROVIDER_LIMIT_MAXIMUMS.dailyOrderLimit, elements.providerDailyOrderLimit],
      ["每日 ENERGY 上限", dailyEnergyLimit, PROVIDER_LIMIT_MAXIMUMS.dailyEnergyLimit, elements.providerDailyEnergyLimit]
    ];
    for (const [label, value, maximum, input] of providerLimits) {
      if (!isBoundedPositiveInteger(value, maximum)) {
        setFormError(elements.providerFormError, `${label}必须是 1 至 ${formatInteger(maximum)} 的整数。`);
        input.focus();
        return;
      }
    }
    if (BigInt(dailyEnergyLimit) < BigInt(maxEnergyPerOrder)) {
      setFormError(elements.providerFormError, "每日 ENERGY 上限必须大于或等于单笔 ENERGY 上限。");
      elements.providerDailyEnergyLimit.focus();
      return;
    }
    if (!state.editingProviderId && !apiKey) {
      setFormError(elements.providerFormError, "新建供应商必须填写 API Key。");
      elements.providerApiKey.focus();
      return;
    }

    const payload = {
      name,
      priority: Number(priority),
      rentTime: Number(elements.providerRentTime.value),
      maxEnergyPerOrder: Number(maxEnergyPerOrder),
      dailyOrderLimit: Number(dailyOrderLimit),
      dailyEnergyLimit: Number(dailyEnergyLimit)
    };
    if (!state.editingProviderId) {
      payload.type = elements.providerType.value;
      payload.enabled = false;
    }
    if (apiKey) payload.apiKey = apiKey;

    const path = state.editingProviderId
      ? `/v1/providers/${encodeURIComponent(state.editingProviderId)}`
      : "/v1/providers";
    setButtonBusy(elements.providerSaveButton, true, "正在保存…");
    try {
      await api(path, { method: state.editingProviderId ? "PATCH" : "POST", body: payload });
      clearProviderSecret();
      elements.providerDialog.close();
      showToast("供应商已保存", "配置已更新，API Key 不会回显。");
      await refreshAll();
    } catch (error) {
      setFormError(elements.providerFormError, friendlyError(error, "保存供应商失败"));
    } finally {
      clearProviderSecret();
      setButtonBusy(elements.providerSaveButton, false, "保存供应商");
    }
  }

  async function toggleProvider(provider, button) {
    const enabled = provider.enabled === false;
    const name = String(provider.name || providerTypeLabel(provider.type));
    if (enabled && !provider.apiKeyConfigured) {
      showToast("无法启用", "请先编辑供应商并配置 API Key。", true);
      return;
    }
    if (enabled) {
      const budgetError = providerEnableBlockReason();
      if (budgetError) {
        showToast("无法启用", budgetError, true);
        return;
      }
    }
    const confirmation = enabled
      ? providerEnableConfirmation(name, provider)
      : `确定停用供应商“${name}”吗？停用只阻止未来的新尝试，不会取消已处于 ORDERING 或 ACCEPTED 的订单。`;
    if (!window.confirm(confirmation)) return;
    setButtonBusy(button, true, enabled ? "启用中…" : "停用中…");
    try {
      await api(`/v1/providers/${encodeURIComponent(String(provider.id || ""))}`, {
        method: "PATCH",
        body: { enabled }
      });
      showToast(enabled ? "供应商已启用" : "供应商已停用", name);
      await refreshAll();
    } catch (error) {
      showToast("操作失败", friendlyError(error, "无法修改供应商状态"), true);
    } finally {
      setButtonBusy(button, false, enabled ? "启用" : "停用");
    }
  }

  function clearProviderSecret() {
    elements.providerApiKey.value = "";
  }

  function providerEnableBlockReason() {
    const budget = state.status?.energyProviders?.budget;
    const requiredValues = [
      budget?.maxEnergyPerOrder,
      budget?.dailyOrderLimit,
      budget?.dailyEnergyLimit,
      budget?.remainingOrders,
      budget?.remainingEnergy
    ];
    if (requiredValues.some((value) => nullableInteger(value) === null)) {
      return "全局付费预算尚未加载，禁止启用供应商。";
    }
    if (nullableInteger(budget.remainingOrders) === "0") return "UTC 当日订单额度已用完，禁止启用供应商。";
    if (nullableInteger(budget.remainingEnergy) === "0") return "UTC 当日 ENERGY 额度已用完，禁止启用供应商。";
    return "";
  }

  function providerEnableConfirmation(name, limits) {
    const perOrder = formatInteger(firstValue(limits?.maxEnergyPerOrder, "--"));
    const dailyOrders = formatInteger(firstValue(limits?.dailyOrderLimit, "--"));
    const dailyEnergy = formatInteger(firstValue(limits?.dailyEnergyLimit, "--"));
    return `确定启用供应商“${name}”吗？启用后新的 Mainnet 交易可能立即创建付费订单。该供应商上限：单笔 ${perOrder} ENERGY、UTC 每日 ${dailyOrders} 单 / ${dailyEnergy} ENERGY；全局预算仍会同时限制。`;
  }

  function providerTypeLabel(type) {
    return String(type || "kuaizu").toLowerCase() === "kuaizu" ? "快租" : "其他供应商";
  }

  function rentTimeLabel(value) {
    return String(value) === "1" ? "1 小时（1）" : String(value) === "15" ? "15 分钟（15）" : `未知（${String(value ?? "--")}）`;
  }

  function providerOrderStateClass(value) {
    const normalized = value.toUpperCase();
    if (["FULFILLED", "SUCCESS", "SUCCEEDED"].includes(normalized)) return "badge-success";
    if (["REJECTED", "UNKNOWN"].includes(normalized)) return "badge-danger";
    if (normalized === "ACCEPTED") return "badge-warning";
    if (["PENDING", "ORDERING"].includes(normalized)) return "badge-info";
    return "badge-neutral";
  }

  function providerOrderStateLabel(value) {
    const labels = {
      PENDING: "等待处理",
      ORDERING: "正在下单",
      ACCEPTED: "供应商已受理",
      FULFILLED: "已交付",
      REJECTED: "已拒绝",
      UNKNOWN: "结果不确定",
      SUCCEEDED: "成功",
      SUCCESS: "成功",
    };
    return labels[value.toUpperCase()] || value;
  }

  async function api(path, options) {
    const headers = new Headers({ Accept: "application/json" });
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options?.body !== undefined) headers.set("Content-Type", "application/json");

    let response;
    try {
      response = await fetch(path, {
        method: options?.method || "GET",
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        credentials: "same-origin",
        signal: options?.signal ?? state.sessionController?.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", { cause: error });
    }

    let payload = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        payload = await response.json();
      } catch (_error) {
        throw new ApiError(response.status, "invalid_response");
      }
    }

    if (!response.ok) {
      throw new ApiError(response.status, payload?.error || response.statusText || "request_failed");
    }
    return payload;
  }

  class ApiError extends Error {
    constructor(status, code, options) {
      super(code, options);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }

  function friendlyError(error, fallback) {
    if (!(error instanceof ApiError)) return fallback;
    const messages = {
      unauthorized: "Token 不正确或已经失效。",
      invalid_request: "提交的数据未通过服务器校验。",
      not_found: "目标记录不存在，可能已被删除。",
      active_reservations: "当前仍有交易占用预留次数，请等待处理完成后再试。",
      unresolved_provider_order: "该地址仍有供应商订单正在处理或等待人工核对，暂时不能重置付费次数。",
      not_found_or_active_reservations: "记录不存在，或当前仍有交易占用预留次数。",
      conflict: "记录已被其他操作修改，请刷新后重新核对。",
      not_ready: "网关尚未就绪，请检查上游节点、数据库和服务状态。",
      provider_storage_unavailable: "供应商配置存储暂不可用，请检查数据库和服务日志。",
      provider_budget_exhausted: "该供应商或全局 UTC 当日付费预算已用完，暂时不能启用。",
      provider_must_be_disabled: "请先停用供应商，复核后再修改 API Key、租期或预算。",
      provider_account_query_unavailable: "供应商账户查询服务尚未启用。",
      provider_credential_unavailable: "供应商 API Key 无法解密，请停用后重新录入。",
      provider_account_query_unsupported: "该供应商暂不支持余额和价格查询。",
      provider_account_unavailable: "暂时无法读取供应商余额和价格，请稍后再试。",
      internal_error: "服务器内部错误，请检查服务日志。",
      network_error: "无法访问管理 API，请检查网络和服务状态。",
      invalid_response: "服务器返回了无法解析的数据。"
    };
    return messages[error.code] || (error.status ? `${fallback}（HTTP ${error.status}）` : fallback);
  }

  function setRefreshTimer() {
    clearRefreshTimer();
    if (document.hidden || !state.token) return;
    const interval = Number(elements.refreshInterval.value);
    if (Number.isFinite(interval) && interval > 0) {
      state.refreshTimer = window.setInterval(() => void refreshAll(), interval);
    }
  }

  function clearRefreshTimer() {
    if (state.refreshTimer !== null) {
      window.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function setConnection(kind, text) {
    elements.connectionPill.classList.toggle("is-offline", kind === "offline");
    elements.connectionPill.classList.toggle("is-loading", kind === "loading");
    setText(elements.connectionText, text);
  }

  function syncLimitField(modeElement, fieldElement, inputElement) {
    const limited = modeElement.value === "limited";
    fieldElement.hidden = !limited;
    inputElement.disabled = !limited;
    inputElement.required = limited;
  }

  function isPaidProviderMode() {
    const mode = String(firstValue(state.status?.gateway?.mode, state.status?.mode, "")).toLowerCase();
    const energySource = String(firstValue(
      state.status?.gateway?.sponsorship?.energySource,
      state.status?.energySource,
      ""
    )).toLowerCase();
    return mode === "sponsor" && energySource === "provider";
  }

  function applyPaidQuotaPolicy() {
    const paidProviderMode = isPaidProviderMode();
    elements.bindingUnlimitedOption.hidden = paidProviderMode;
    elements.bindingUnlimitedOption.disabled = paidProviderMode;
    elements.resetUnlimitedOption.hidden = paidProviderMode;
    elements.resetUnlimitedOption.disabled = paidProviderMode;
    elements.bindingPaidQuotaNotice.hidden = !paidProviderMode;
    elements.resetPaidQuotaNotice.hidden = !paidProviderMode;
    if (paidProviderMode && elements.bindingLimitMode.value === "unlimited") {
      elements.bindingLimitMode.value = "limited";
      syncLimitField(elements.bindingLimitMode, elements.bindingLimitField, elements.bindingLimit);
    }
    if (paidProviderMode && elements.resetLimitMode.value === "unlimited") {
      elements.resetLimitMode.value = "limited";
      syncLimitField(elements.resetLimitMode, elements.resetLimitField, elements.resetLimit);
    }
  }

  function createCell(label, className) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (className) cell.className = className;
    return cell;
  }

  function createActionButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-button";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function requestStateClass(value) {
    const normalized = value.toUpperCase();
    if (["SOLIDIFIED_SUCCESS", "UPSTREAM_ACCEPTED"].includes(normalized)) return "badge-success";
    if (["FAILED", "SOLIDIFIED_FAILED", "UPSTREAM_REJECTED", "EXPIRED"].includes(normalized)) return "badge-danger";
    if (["RECEIVED", "QUOTA_RESERVED", "RESOURCE_ESTIMATED", "RESOURCE_READY"].includes(normalized)) return "badge-info";
    return "badge-neutral";
  }

  function requestStateLabel(value) {
    const labels = {
      RECEIVED: "已接收",
      QUOTA_RESERVED: "次数已预留",
      RESOURCE_ESTIMATED: "资源已估算",
      RESOURCE_READY: "资源已就绪",
      UPSTREAM_ACCEPTED: "节点已接受",
      UPSTREAM_REJECTED: "节点已拒绝",
      SOLIDIFIED_SUCCESS: "已固化成功",
      SOLIDIFIED_FAILED: "已固化失败",
      FAILED: "处理失败",
      EXPIRED: "已过期"
    };
    return labels[value.toUpperCase()] || value;
  }

  function isBindingUsable(binding) {
    return binding.enabled !== false && !isExpired(binding.expiresAt) && hasQuota(binding);
  }

  function hasQuota(binding) {
    const maximum = nullableInteger(binding.maxTransactions);
    if (maximum === null) return true;
    try {
      return BigInt(integerString(binding.usedTransactions, "0")) +
        BigInt(integerString(binding.reservedTransactions, "0")) < BigInt(maximum);
    } catch (_error) {
      return false;
    }
  }

  function isExpired(value) {
    if (!value) return false;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time <= Date.now();
  }

  function percentage(used, reserved, maximum) {
    try {
      const total = BigInt(used) + BigInt(reserved);
      const max = BigInt(maximum);
      if (max === 0n) return 100;
      const scaled = Number((total * 10000n) / max) / 100;
      return Math.max(0, Math.min(100, scaled));
    } catch (_error) {
      return 0;
    }
  }

  function integerString(value, fallback) {
    const text = value == null ? "" : String(value);
    return /^\d+$/.test(text) ? text : fallback;
  }

  function positiveIntegerString(value) {
    const text = value == null ? "" : String(value);
    return /^[1-9]\d*$/.test(text) ? text : null;
  }

  function decimalString(value) {
    const text = value == null ? "" : String(value).trim();
    return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
  }

  function positiveDecimalString(value) {
    const text = decimalString(value);
    return text !== null && /[1-9]/.test(text) ? text : null;
  }

  function nullableInteger(value) {
    if (value === null || value === undefined || value === "") return null;
    return integerString(value, "0");
  }

  function isNonNegativeInteger(value) {
    return /^\d+$/.test(value);
  }

  function isBoundedPositiveInteger(value, maximum) {
    if (!/^[1-9]\d*$/.test(value)) return false;
    try {
      return BigInt(value) <= BigInt(maximum);
    } catch (_error) {
      return false;
    }
  }

  function findBlockingProviderOrder(address) {
    const blockingStates = new Set(["ORDERING", "ACCEPTED", "UNKNOWN"]);
    return state.providerOrders.find((order) => {
      const receiveAddress = String(firstValue(
        order.receiveAddress,
        order.receive_address,
        order.receiverAddress,
        order.receiver_address,
        order.address
      ) ?? "");
      const orderState = String(firstValue(order.state, order.status, "")).toUpperCase();
      return receiveAddress === address && blockingStates.has(orderState);
    }) || null;
  }

  function formatInteger(value) {
    const text = String(value ?? "0");
    if (!/^\d+$/.test(text)) return text;
    try {
      return new Intl.NumberFormat("zh-CN").format(BigInt(text));
    } catch (_error) {
      return text;
    }
  }

  function formatDecimal(value) {
    const text = decimalString(value);
    if (text === null) return "--";
    const [whole, fraction] = text.split(".");
    return fraction === undefined ? formatInteger(whole) : `${formatInteger(whole)}.${fraction}`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(date);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(value);
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(value);
  }

  function toLocalDateTimeInput(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function shorten(value, start, end) {
    const text = String(value || "");
    if (text.length <= start + end + 3) return text;
    return `${text.slice(0, start)}…${text.slice(-end)}`;
  }

  function firstValue(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function extractArray(payload, key) {
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload?.[key]) ? payload[key] : [];
  }

  function setText(element, value) {
    element.textContent = value == null ? "" : String(value);
  }

  function clearNode(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function setFormError(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }

  function setButtonBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  function showToast(title, message, isError) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " is-error" : ""}`;
    const content = document.createElement("div");
    const titleElement = document.createElement("strong");
    const messageElement = document.createElement("span");
    titleElement.textContent = title;
    messageElement.textContent = message;
    content.append(titleElement, messageElement);
    toast.appendChild(content);
    elements.toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4500);
  }
})();
