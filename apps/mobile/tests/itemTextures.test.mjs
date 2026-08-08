import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MINECRAFT_ASSETS_BASE_URL,
  headTextureUrl,
  isValidTextureId,
  mcHeadsAvatarUrl,
  minecraftAssetVersion,
  minecraftSkinAspectRatio,
  minecraftSpecialItemTexture,
  minecraftTextureUrls,
  nextImageTierIndex,
  normalizeMinecraftAssetName,
  playerHeadTextureTiers,
  resolveMinecraftAssetsBaseUrl,
} from "../src/itemTextures.ts";

const TEXTURE_ID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PLAYER_UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

test("uses the runtime asset base when configured", () => {
  // Given
  const runtimeBase = " https://assets.example.test/minecraft/ ";
  const envBase = "https://env.example.test/assets";

  // When
  const result = resolveMinecraftAssetsBaseUrl(runtimeBase, envBase);

  // Then
  assert.equal(result, "https://assets.example.test/minecraft");
});

test("uses the environment asset base when runtime configuration is blank", () => {
  // Given
  const runtimeBase = " ";
  const envBase = " https://env.example.test/assets/// ";

  // When
  const result = resolveMinecraftAssetsBaseUrl(runtimeBase, envBase);

  // Then
  assert.equal(result, "https://env.example.test/assets");
});

test("uses the PrismarineJS raw base when no override is configured", () => {
  // Given
  const runtimeBase = undefined;
  const envBase = undefined;

  // When
  const result = resolveMinecraftAssetsBaseUrl(runtimeBase, envBase);

  // Then
  assert.equal(result, DEFAULT_MINECRAFT_ASSETS_BASE_URL);
});

test("normalizes vanilla item resource names", () => {
  // Given
  const names = [" Diamond_Sword ", "minecraft:Oak_Log"];

  // When
  const results = names.map(normalizeMinecraftAssetName);

  // Then
  assert.deepEqual(results, ["diamond_sword", "oak_log"]);
});

test("rejects custom namespaces and unsafe item names", () => {
  // Given
  const names = [
    "custom:diamond_sword",
    "minecraft:../diamond_sword",
    "minecraft:oak/log",
    "minecraft:stone?raw=1",
    "minecraft:",
  ];

  // When
  const results = names.map(normalizeMinecraftAssetName);

  // Then
  assert.deepEqual(results, [null, null, null, null, null]);
});

test("maps active game versions to published Prismarine datasets", () => {
  // Given
  const versions = ["1.21.11", "1.21.3", "1.20.6", "1.19.4", "../1.21.11"];

  // When
  const results = versions.map(minecraftAssetVersion);

  // Then
  assert.deepEqual(results, ["1.21.11", "1.21.4", "1.20.2", "1.19.1", null]);
});

test("builds item-first and block-fallback texture URLs", () => {
  // Given
  const baseUrl = "https://assets.example.test/root/";

  // When
  const result = minecraftTextureUrls(baseUrl, "1.20", "minecraft:Stone");

  // Then
  assert.deepEqual(result, [
    "https://assets.example.test/root/data/1.20.2/items/stone.png",
    "https://assets.example.test/root/data/1.20.2/blocks/stone.png",
  ]);
});

test("uses entity atlases for chest-family icons", () => {
  const baseUrl = "https://assets.example.test/root";

  assert.deepEqual(
    minecraftSpecialItemTexture(baseUrl, "1.21.11", "minecraft:chest"),
    {
      kind: "chest",
      url: "https://assets.example.test/root/data/1.21.11/entity/chest/normal.png",
    },
  );
  assert.equal(
    minecraftSpecialItemTexture(baseUrl, "1.21.11", "waxed_oxidized_copper_chest")?.url,
    "https://assets.example.test/root/data/1.21.11/entity/chest/copper_oxidized.png",
  );
  assert.equal(
    minecraftSpecialItemTexture(baseUrl, "1.21.11", "diamond_sword"),
    null,
  );
});

test("adds material fallbacks for model-rendered GUI items", () => {
  const baseUrl = "https://assets.example.test/root";

  assert.equal(
    minecraftTextureUrls(baseUrl, "1.21.11", "red_bed").at(-1),
    "https://assets.example.test/root/data/1.21.11/blocks/red_wool.png",
  );
  assert.equal(
    minecraftTextureUrls(baseUrl, "1.21.11", "white_banner").at(-1),
    "https://assets.example.test/root/data/1.21.11/blocks/white_wool.png",
  );
  assert.equal(
    minecraftTextureUrls(baseUrl, "1.21.11", "decorated_pot").at(-1),
    "https://assets.example.test/root/data/1.21.11/blocks/terracotta.png",
  );
});

test("does not build texture URLs for invalid resource inputs", () => {
  // Given
  const baseUrl = "https://assets.example.test/root";

  // When
  const invalidName = minecraftTextureUrls(baseUrl, "1.21.11", "custom:item");
  const invalidVersion = minecraftTextureUrls(baseUrl, "../1.21.11", "stone");

  // Then
  assert.deepEqual(invalidName, []);
  assert.deepEqual(invalidVersion, []);
});

test("builds direct Mojang texture URLs only for validated ids", () => {
  assert.equal(isValidTextureId(TEXTURE_ID), true);
  assert.equal(
    headTextureUrl(TEXTURE_ID),
    `https://textures.minecraft.net/texture/${TEXTURE_ID}`,
  );

  for (const invalid of [
    "../" + TEXTURE_ID,
    TEXTURE_ID.toUpperCase(),
    "0123456789abcdef",
    `${TEXTURE_ID}/extra`,
  ]) {
    assert.equal(isValidTextureId(invalid), false);
    assert.equal(headTextureUrl(invalid), null);
  }
});

test("validates mc-heads avatar identifiers before constructing URLs", () => {
  assert.equal(
    mcHeadsAvatarUrl(PLAYER_UUID),
    `https://mc-heads.net/avatar/${PLAYER_UUID}`,
  );
  assert.equal(
    mcHeadsAvatarUrl("Dinnerbone"),
    "https://mc-heads.net/avatar/Dinnerbone",
  );
  assert.equal(mcHeadsAvatarUrl("../player"), null);
  assert.equal(mcHeadsAvatarUrl("name with spaces"), null);
});

test("selects direct texture then UUID and name avatar tiers", () => {
  assert.deepEqual(
    playerHeadTextureTiers({
      textureId: TEXTURE_ID,
      playerUuid: PLAYER_UUID,
      playerName: "Dinnerbone",
    }),
    [
      {
        kind: "skin",
        url: `https://textures.minecraft.net/texture/${TEXTURE_ID}`,
      },
      {
        kind: "avatar",
        url: `https://mc-heads.net/avatar/${PLAYER_UUID}`,
      },
      {
        kind: "avatar",
        url: "https://mc-heads.net/avatar/Dinnerbone",
      },
    ],
  );
});

test("advances failed image tiers in order and stops after exhaustion", () => {
  const tiers = playerHeadTextureTiers({
    textureId: TEXTURE_ID,
    playerUuid: PLAYER_UUID,
    playerName: "Dinnerbone",
  });

  assert.equal(nextImageTierIndex(0, tiers.length), 1);
  assert.equal(nextImageTierIndex(1, tiers.length), 2);
  assert.equal(nextImageTierIndex(2, tiers.length), null);
  assert.equal(nextImageTierIndex(null, tiers.length), null);
});

test("skips invalid player-head tiers without echoing hostile input", () => {
  assert.deepEqual(
    playerHeadTextureTiers({
      textureId: "https://evil.example/texture/" + TEXTURE_ID,
      playerUuid: "not-a-uuid",
      playerName: "../admin",
    }),
    [],
  );
});

test("preserves modern and legacy Minecraft skin aspect ratios", () => {
  assert.equal(minecraftSkinAspectRatio(64, 64), 1);
  assert.equal(minecraftSkinAspectRatio(64, 32), 0.5);
  assert.equal(minecraftSkinAspectRatio(128, 64), 0.5);
  assert.equal(minecraftSkinAspectRatio(0, 0), 1);
  assert.equal(minecraftSkinAspectRatio(64, 48), 1);
});
