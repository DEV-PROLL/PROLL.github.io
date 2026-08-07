export const DEFAULT_MINECRAFT_ASSETS_BASE_URL =
  "https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master";

declare global {
  var __MINECRAFT_ASSETS_BASE_URL__: string | undefined;
}

const ASSET_VERSION_OVERRIDES: Readonly<Record<string, string>> = {
  "1.19.2": "1.19.1",
  "1.19.3": "1.19.1",
  "1.19.4": "1.19.1",
  "1.20": "1.20.2",
  "1.20.1": "1.20.2",
  "1.20.4": "1.20.2",
  "1.20.6": "1.20.2",
  "1.21.2": "1.21.4",
  "1.21.3": "1.21.4",
} as const;

export function resolveMinecraftAssetsBaseUrl(
  runtimeValue: unknown,
  envValue: string | undefined,
): string {
  const runtimeBase = typeof runtimeValue === "string" ? runtimeValue.trim() : "";
  const envBase = envValue?.trim() ?? "";
  const configuredBase = runtimeBase || envBase || DEFAULT_MINECRAFT_ASSETS_BASE_URL;
  return configuredBase.replace(/\/+$/, "");
}

export function normalizeMinecraftAssetName(name: string): string | null {
  const resourceLocation = name.trim().toLowerCase();
  const separatorIndex = resourceLocation.indexOf(":");
  const hasNamespace = separatorIndex >= 0;
  const namespace = hasNamespace ? resourceLocation.slice(0, separatorIndex) : "minecraft";
  const itemName = hasNamespace ? resourceLocation.slice(separatorIndex + 1) : resourceLocation;

  if (namespace !== "minecraft") return null;
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(itemName)) return null;
  return itemName;
}

export function minecraftAssetVersion(mcVersion: string): string | null {
  const version = mcVersion.trim();
  if (!/^1\.\d+(?:\.\d+)?$/.test(version)) return null;
  return ASSET_VERSION_OVERRIDES[version] ?? version;
}

export function minecraftTextureUrls(
  baseUrl: string,
  mcVersion: string,
  itemName: string,
): readonly string[] {
  const version = minecraftAssetVersion(mcVersion);
  const normalizedName = normalizeMinecraftAssetName(itemName);
  if (!version || !normalizedName) return [];

  const normalizedBaseUrl = resolveMinecraftAssetsBaseUrl(baseUrl, undefined);
  const textureRoot = `${normalizedBaseUrl}/data/${version}`;
  return [
    `${textureRoot}/items/${normalizedName}.png`,
    `${textureRoot}/blocks/${normalizedName}.png`,
  ];
}

const runtimeAssetsBaseUrl =
  typeof globalThis !== "undefined"
    ? globalThis.__MINECRAFT_ASSETS_BASE_URL__
    : undefined;
const envAssetsBaseUrl =
  typeof process !== "undefined"
    ? process.env.EXPO_PUBLIC_MINECRAFT_ASSETS_BASE_URL
    : undefined;

export const MINECRAFT_ASSETS_BASE_URL = resolveMinecraftAssetsBaseUrl(
  runtimeAssetsBaseUrl,
  envAssetsBaseUrl,
);
