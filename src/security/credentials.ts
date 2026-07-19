import { readFile } from "node:fs/promises";

import { z } from "zod";

const privateKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

export interface ClobApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingCredentials {
  privateKey: `0x${string}`;
  clob: ClobApiCredentials | null;
}

async function readRequiredSecretFile(environmentName: string): Promise<string> {
  const filePath = process.env[environmentName]?.trim();
  if (!filePath) {
    throw new Error(`${environmentName} must point to a runtime credential file`);
  }

  const value = (await readFile(filePath, "utf8")).trim();
  if (!value) {
    throw new Error(`${environmentName} points to an empty credential file`);
  }
  return value;
}

async function readOptionalSecretFile(environmentName: string): Promise<string | null> {
  const filePath = process.env[environmentName]?.trim();
  if (!filePath) {
    return null;
  }
  const value = (await readFile(filePath, "utf8")).trim();
  if (!value) {
    throw new Error(`${environmentName} points to an empty credential file`);
  }
  return value;
}

export async function loadTradingCredentials(): Promise<TradingCredentials> {
  const privateKeyRaw = await readRequiredSecretFile("POLYMARKET_PRIVATE_KEY_FILE");
  const privateKey = privateKeySchema.safeParse(privateKeyRaw);
  if (!privateKey.success) {
    throw new Error("POLYMARKET_PRIVATE_KEY_FILE does not contain a valid 32-byte private key");
  }

  const [key, secret, passphrase] = await Promise.all([
    readOptionalSecretFile("POLYMARKET_CLOB_API_KEY_FILE"),
    readOptionalSecretFile("POLYMARKET_CLOB_API_SECRET_FILE"),
    readOptionalSecretFile("POLYMARKET_CLOB_API_PASSPHRASE_FILE"),
  ]);
  const configuredCount = [key, secret, passphrase].filter((value) => value !== null).length;
  if (configuredCount !== 0 && configuredCount !== 3) {
    throw new Error("CLOB credential files must be configured as a complete key/secret/passphrase set");
  }

  return {
    privateKey: privateKey.data as `0x${string}`,
    clob: key && secret && passphrase ? { key, secret, passphrase } : null,
  };
}
