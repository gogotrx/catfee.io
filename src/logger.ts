import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "privateKey",
        "RESOURCE_PRIVATE_KEY",
        "apiKey",
        "*.apiKey",
        "PROVIDER_MASTER_KEY",
        "providerMasterKey",
        "signerToken",
        "adminToken",
        "req.headers.authorization"
      ],
      censor: "[REDACTED]"
    }
  });
}

export type AppLogger = ReturnType<typeof createLogger>;

export const logger = createLogger(process.env.LOG_LEVEL ?? "info");
