import { join } from "node:path";
import { readStoredCredential } from "@code-yeongyu/senpi";

// What the agent directory's credential store says about one provider. The integration list needs
// only presence and kind, never a secret: this module inspects the stored entry's shape and returns
// which method it holds, so no key, token or environment value can reach an HTTP response.

export type StoredCredentialMethod = "key" | "oauth";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function carriesSecret(value: Record<string, unknown>): boolean {
  if (typeof value.key === "string" && value.key.length > 0) return true;
  if (typeof value.access === "string" && value.access.length > 0) return true;
  return false;
}

/** A pooled provider credential keeps its material in `accounts`; the flat fields may stay empty. */
function hasCredentialMaterial(credential: Record<string, unknown>): boolean {
  if (carriesSecret(credential)) return true;
  const accounts = credential.accounts;
  if (!Array.isArray(accounts)) return false;
  return accounts.some((account) => isRecord(account) && carriesSecret(account));
}

/**
 * The credential method `auth.json` in `agentDir` holds for `providerID`, or undefined when the
 * store has no entry, the entry is unreadable, or it carries no key material at all. `readStoredCredential`
 * is the pinned package's own one-off reader, so the bridge parses the store exactly as the host does.
 */
export function storedCredentialMethod(agentDir: string, providerID: string): StoredCredentialMethod | undefined {
  if (providerID.length === 0) return undefined;
  let credential: unknown;
  try {
    credential = readStoredCredential(providerID, join(agentDir, "auth.json"));
  } catch {
    // An unreadable store is treated as "no credential" so a listing read never becomes an outage.
    return undefined;
  }
  if (!isRecord(credential) || !hasCredentialMaterial(credential)) return undefined;
  if (credential.type === "api_key") return "key";
  if (credential.type === "oauth") return "oauth";
  return undefined;
}
