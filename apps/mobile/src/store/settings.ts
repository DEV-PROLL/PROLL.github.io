import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY_BRIDGE_URL = "bridge_url";
const KEY_SERVER_ID = "server_id";
const KEY_SERVER_ADDRESS = "server_address";
const KEY_USER_ID = "user_id";
const KEY_ACCOUNTS = "accounts";
const KEY_MC_VERSION = "mc_version";
const KEY_PENDING_LOGIN_REQUEST_ID = "pending_login_request_id";

export interface SavedAccount {
  userId: string;
  ign: string;
  uuid?: string;
  lastUsedAt: number;
}

export async function getBridgeUrl(): Promise<string | null> {
  return getStoredItem(KEY_BRIDGE_URL);
}

export async function setBridgeUrl(url: string): Promise<void> {
  await setStoredItem(KEY_BRIDGE_URL, url);
}

export async function clearBridgeUrl(): Promise<void> {
  await deleteStoredItem(KEY_BRIDGE_URL);
}

export async function getServerId(): Promise<string | null> {
  return getStoredItem(KEY_SERVER_ID);
}

export async function setServerId(serverId: string): Promise<void> {
  await setStoredItem(KEY_SERVER_ID, serverId);
}

export async function getServerAddress(): Promise<string | null> {
  return getStoredItem(KEY_SERVER_ADDRESS);
}

export async function setServerAddress(address: string): Promise<void> {
  await setStoredItem(KEY_SERVER_ADDRESS, address);
}

export async function getMcVersion(): Promise<string | null> {
  return getStoredItem(KEY_MC_VERSION);
}

export async function setMcVersion(version: string): Promise<void> {
  await setStoredItem(KEY_MC_VERSION, version);
}

export async function getCachedUserId(): Promise<string | null> {
  return getStoredItem(KEY_USER_ID);
}

export async function setCachedUserId(userId: string): Promise<void> {
  await setStoredItem(KEY_USER_ID, userId);
}

export async function clearCachedUserId(): Promise<void> {
  await deleteStoredItem(KEY_USER_ID);
}

export async function getPendingLoginRequestId(): Promise<string | null> {
  return getStoredItem(KEY_PENDING_LOGIN_REQUEST_ID);
}

export async function setPendingLoginRequestId(requestId: string): Promise<void> {
  await setStoredItem(KEY_PENDING_LOGIN_REQUEST_ID, requestId);
}

export async function clearPendingLoginRequestId(): Promise<void> {
  await deleteStoredItem(KEY_PENDING_LOGIN_REQUEST_ID);
}

export async function getSavedAccounts(): Promise<SavedAccount[]> {
  const raw = await getStoredItem(KEY_ACCOUNTS);
  let accounts: SavedAccount[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as SavedAccount[];
      if (Array.isArray(parsed)) {
        accounts = parsed.filter(
          (account) =>
            typeof account?.userId === "string" &&
            typeof account?.ign === "string",
        ).map((account) => ({
          userId: account.userId,
          ign: account.ign,
          uuid: typeof account.uuid === "string" ? account.uuid : undefined,
          lastUsedAt:
            typeof account.lastUsedAt === "number" ? account.lastUsedAt : 0,
        }));
      }
    } catch {
      accounts = [];
    }
  }

  // Migrate the original single-account cache without forcing users to log in
  // again after an app update.
  const legacyUserId = await getCachedUserId();
  if (
    legacyUserId &&
    !accounts.some((account) => account.userId === legacyUserId)
  ) {
    accounts.unshift({
      userId: legacyUserId,
      ign: legacyUserId,
      lastUsedAt: 0,
    });
    await setSavedAccounts(accounts);
  }

  return accounts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

async function setSavedAccounts(accounts: SavedAccount[]): Promise<void> {
  await setStoredItem(KEY_ACCOUNTS, JSON.stringify(accounts));
}

export async function saveAccount(account: {
  userId: string;
  ign: string;
  uuid?: string;
}): Promise<SavedAccount[]> {
  const accounts = await getSavedAccounts();
  const next: SavedAccount[] = [
    { ...account, lastUsedAt: Date.now() },
    ...accounts.filter((item) => item.userId !== account.userId),
  ];
  await setSavedAccounts(next);
  await setCachedUserId(account.userId);
  await clearPendingLoginRequestId();
  return next;
}

export async function removeSavedAccount(userId: string): Promise<SavedAccount[]> {
  const accounts = await getSavedAccounts();
  const removed = accounts.filter(
    (account) => account.userId === userId || account.ign === userId,
  );
  const next = accounts.filter(
    (account) => account.userId !== userId && account.ign !== userId,
  );
  await setSavedAccounts(next);
  const currentUserId = await getCachedUserId();
  if (
    currentUserId === userId ||
    removed.some(
      (account) => account.userId === currentUserId || account.ign === currentUserId,
    )
  ) {
    await clearCachedUserId();
  }
  return next;
}

export async function clearSavedAccounts(): Promise<void> {
  await deleteStoredItem(KEY_ACCOUNTS);
  await clearCachedUserId();
}

async function getStoredItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") return webStorage().getItem(key);
  return SecureStore.getItemAsync(key);
}

async function setStoredItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    webStorage().setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteStoredItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    webStorage().removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

function webStorage(): Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("localStorage is unavailable in this browser");
  }
  return globalThis.localStorage;
}
