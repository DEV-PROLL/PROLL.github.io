import * as SecureStore from "expo-secure-store";

const KEY_BRIDGE_URL = "bridge_url";
const KEY_USER_ID = "user_id";

export async function getBridgeUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_BRIDGE_URL);
}

export async function setBridgeUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_BRIDGE_URL, url);
}

export async function clearBridgeUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_BRIDGE_URL);
}

export async function getCachedUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_USER_ID);
}

export async function setCachedUserId(userId: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_USER_ID, userId);
}

export async function clearCachedUserId(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_USER_ID);
}
