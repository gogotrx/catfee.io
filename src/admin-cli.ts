const baseUrl = process.env.ADMIN_URL ?? "http://127.0.0.1:8080";
const token = process.env.ADMIN_TOKEN;
if (!token) fail("ADMIN_TOKEN is required");

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
    await request("GET", "/v1/bindings");
    break;
  case "bind": {
    const [address, maximum, label, expiresAt] = args;
    if (!address || !maximum) fail("Usage: npm run admin -- bind <address> <count|unlimited> [label] [expires-at]");
    await request("POST", "/v1/bindings", {
      address,
      maxTransactions: maximum === "unlimited" ? null : maximum,
      label: label ?? null,
      expiresAt: expiresAt ?? null,
      enabled: true
    });
    break;
  }
  case "enable":
  case "disable": {
    const [address] = args;
    if (!address) fail(`Usage: npm run admin -- ${command} <address>`);
    await request("PATCH", `/v1/bindings/${encodeURIComponent(address)}`, { enabled: command === "enable" });
    break;
  }
  case "reset": {
    const [address, maximum] = args;
    if (!address) fail("Usage: npm run admin -- reset <address> [count|unlimited]");
    await request("POST", `/v1/bindings/${encodeURIComponent(address)}/reset`,
      maximum === undefined ? {} : { maxTransactions: maximum === "unlimited" ? null : maximum });
    break;
  }
  case "request": {
    const [txId] = args;
    if (!txId) fail("Usage: npm run admin -- request <tx-id>");
    await request("GET", `/v1/requests/${encodeURIComponent(txId)}`);
    break;
  }
  default:
    fail("Commands: list | bind <address> <count|unlimited> [label] [expires-at] | enable <address> | disable <address> | reset <address> [count|unlimited] | request <tx-id>");
}

async function request(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(new URL(path, ensureSlash(baseUrl)), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) fail(`Admin API returned ${response.status}: ${text}`);
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  } catch {
    process.stdout.write(`${text}\n`);
  }
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
