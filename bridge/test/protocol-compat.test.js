const assert = require("node:assert/strict");
const test = require("node:test");
const minecraftProtocol = require("minecraft-protocol");
const { patchMinecraftDataProtocol } = require("../dist/protocol-compat.js");

function varint(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function string(value) {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([varint(content.length), content]);
}

function double(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer;
}

function attribute(typeId, name, value, operation, slot, display) {
  return Buffer.concat([
    varint(typeId),
    string(name),
    double(value),
    varint(operation),
    varint(slot),
    varint(display),
  ]);
}

function equipmentPacketWithPerEntryDisplays() {
  return Buffer.concat([
    varint(0x64), // entity_equipment packet id in protocol 774
    varint(1), // entity id
    Buffer.from([0]), // final equipment entry, main hand
    varint(1), // item count
    varint(941), // item id from the captured failing packet
    varint(1), // added component count
    varint(0), // removed component count
    varint(16), // attribute_modifiers component
    varint(2), // modifier count
    attribute(2, "skript:sword_upgrade_damage", 1, 0, 0, 0),
    attribute(2, "minecraft:base_attack_damage", 6, 0, 1, 1),
  ]);
}

test("patch is restricted to Minecraft protocol 774", () => {
  assert.equal(patchMinecraftDataProtocol("1.21.10"), false);
});

test("decodes 1.21.11 attribute displays from every equipment modifier", () => {
  assert.equal(patchMinecraftDataProtocol("1.21.11"), true);
  assert.equal(patchMinecraftDataProtocol("1.21.11"), false);

  const deserializer = minecraftProtocol.createDeserializer({
    state: minecraftProtocol.states.PLAY,
    version: "1.21.11",
  });
  const parsed = deserializer.parsePacketBuffer(
    equipmentPacketWithPerEntryDisplays(),
  );
  const modifiers =
    parsed.data.params.equipments[0].item.components[0].data.attributes;

  assert.equal(parsed.data.name, "entity_equipment");
  assert.deepEqual(modifiers, [
    {
      typeId: 2,
      name: "skript:sword_upgrade_damage",
      value: 1,
      operation: "add",
      slot: "any",
      display: { type: "default", component: undefined },
    },
    {
      typeId: 2,
      name: "minecraft:base_attack_damage",
      value: 6,
      operation: "add",
      slot: "main_hand",
      display: { type: "hidden", component: undefined },
    },
  ]);
});
