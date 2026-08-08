export const DEFAULT_MINECRAFT_ASSETS_BASE_URL =
  "https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master";
const PLAYER_HEAD_TEXTURE_BASE_URL = "https://textures.minecraft.net/texture";
const MC_HEADS_AVATAR_BASE_URL = "https://mc-heads.net/avatar";

export interface PlayerHeadMetadata {
  readonly playerUuid?: string;
  readonly playerName?: string;
  readonly textureId?: string;
}

export interface PlayerHeadTextureTier {
  readonly kind: "skin" | "avatar";
  readonly url: string;
}

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

export function minecraftSkinAspectRatio(
  sourceWidth: number,
  sourceHeight: number,
): 0.5 | 1 {
  return (
    Number.isFinite(sourceWidth) &&
    Number.isFinite(sourceHeight) &&
    sourceWidth > 0 &&
    sourceHeight > 0 &&
    sourceHeight * 2 === sourceWidth
  )
    ? 0.5
    : 1;
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

export function isValidTextureId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

export function headTextureUrl(textureId: unknown): string | null {
  return isValidTextureId(textureId)
    ? `${PLAYER_HEAD_TEXTURE_BASE_URL}/${textureId}`
    : null;
}

export function mcHeadsAvatarUrl(identifier: unknown): string | null {
  if (typeof identifier !== "string") return null;
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      identifier,
    );
  const isPlayerName = /^[A-Za-z0-9_]{1,16}$/.test(identifier);
  return isUuid || isPlayerName
    ? `${MC_HEADS_AVATAR_BASE_URL}/${identifier}`
    : null;
}

export function playerHeadTextureTiers(
  head: PlayerHeadMetadata | null | undefined,
): readonly PlayerHeadTextureTier[] {
  if (!head) return [];
  const tiers: PlayerHeadTextureTier[] = [];
  const textureUrl = headTextureUrl(head.textureId);
  const uuidUrl = mcHeadsAvatarUrl(head.playerUuid);
  const nameUrl = mcHeadsAvatarUrl(head.playerName);
  if (textureUrl) tiers.push({ kind: "skin", url: textureUrl });
  if (uuidUrl) tiers.push({ kind: "avatar", url: uuidUrl });
  if (nameUrl) tiers.push({ kind: "avatar", url: nameUrl });
  return tiers;
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
