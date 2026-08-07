import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MINECRAFT_ASSETS_BASE_URL,
  minecraftAssetVersion,
  minecraftTextureUrls,
  normalizeMinecraftAssetName,
  resolveMinecraftAssetsBaseUrl,
} from "../src/itemTextures.ts";

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
