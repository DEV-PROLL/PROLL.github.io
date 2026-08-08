export const MAP_PALETTE = [
  "#00000000",
  "#52733f",
  "#5f8448",
  "#6b9551",
  "#3f6738",
  "#497740",
  "#538748",
  "#315f91",
  "#386da6",
  "#3f7bbb",
  "#b94a20",
  "#d55525",
  "#ef602a",
  "#ad965d",
  "#c7ac6b",
  "#e0c179",
  "#c7cbd0",
  "#e4e8ed",
  "#ffffff",
  "#6f7072",
  "#808184",
  "#909193",
  "#765638",
  "#886340",
  "#9a7048",
  "#79532f",
  "#8b6036",
  "#9d6c3d",
  "#6e3029",
  "#7e372f",
  "#8f3e35",
  "#8e8460",
  "#a3986e",
  "#b8ab7c",
  "#6e6b68",
  "#7f7b77",
  "#8f8b86",
] as const;

const AIR_BLOCKS: ReadonlySet<string> = new Set([
  "air",
  "cave_air",
  "void_air",
]);

const FAMILY_INDEX = {
  grass: 1,
  foliage: 4,
  water: 7,
  lava: 10,
  sand: 13,
  snow: 16,
  stone: 19,
  dirt: 22,
  wood: 25,
  nether: 28,
  end: 31,
  generic: 34,
} as const;

export function isAirBlockName(blockName: string): boolean {
  return AIR_BLOCKS.has(blockName);
}

export function surfacePaletteIndex(
  blockName: string,
  surfaceY: number,
  centerY: number,
): number {
  const familyIndex = classifyFamily(blockName);
  const shadeOffset = surfaceY >= centerY + 8 ? 2 : surfaceY <= centerY - 8 ? 0 : 1;
  return familyIndex + shadeOffset;
}

function classifyFamily(blockName: string): number {
  if (blockName.includes("water")) return FAMILY_INDEX.water;
  if (blockName.includes("lava")) return FAMILY_INDEX.lava;
  if (
    blockName.includes("snow") ||
    blockName.includes("ice") ||
    blockName.includes("quartz")
  ) {
    return FAMILY_INDEX.snow;
  }
  if (
    blockName.includes("sand") ||
    blockName.includes("gravel") ||
    blockName.includes("terracotta")
  ) {
    return FAMILY_INDEX.sand;
  }
  if (
    blockName.includes("leaves") ||
    blockName.includes("vine") ||
    blockName.includes("moss") ||
    blockName.includes("azalea")
  ) {
    return FAMILY_INDEX.foliage;
  }
  if (blockName.includes("grass") || blockName.includes("farmland")) {
    return FAMILY_INDEX.grass;
  }
  if (
    blockName.includes("dirt") ||
    blockName.includes("mud") ||
    blockName.includes("clay")
  ) {
    return FAMILY_INDEX.dirt;
  }
  if (
    blockName.includes("log") ||
    blockName.includes("wood") ||
    blockName.includes("planks") ||
    blockName.includes("stem") ||
    blockName.includes("hyphae")
  ) {
    return FAMILY_INDEX.wood;
  }
  if (
    blockName.includes("netherrack") ||
    blockName.includes("nether_") ||
    blockName.includes("basalt") ||
    blockName.includes("magma")
  ) {
    return FAMILY_INDEX.nether;
  }
  if (
    blockName.includes("end_stone") ||
    blockName.includes("purpur") ||
    blockName.includes("chorus")
  ) {
    return FAMILY_INDEX.end;
  }
  if (
    blockName.includes("stone") ||
    blockName.includes("ore") ||
    blockName.includes("brick") ||
    blockName.includes("concrete") ||
    blockName.includes("bedrock")
  ) {
    return FAMILY_INDEX.stone;
  }
  return FAMILY_INDEX.generic;
}
