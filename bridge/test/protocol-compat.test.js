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

function int16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
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

function setSlotPacketWithZeroDamageTypeHolder() {
  return Buffer.concat([
    varint(0x14), // set_slot packet id in protocol 774
    varint(1), // window id
    varint(0), // state id
    int16(0), // slot
    varint(1), // item count
    varint(1), // item id
    varint(1), // added component count
    varint(0), // removed component count
    varint(8), // damage_type component
    Buffer.from([1]), // EitherHolder: registry holder branch
    varint(0), // valid registry id 0 (not inline NBT)
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

test("decodes 1.21.11 id-zero EitherHolder item components without reading NBT", () => {
  patchMinecraftDataProtocol("1.21.11");

  const deserializer = minecraftProtocol.createDeserializer({
    state: minecraftProtocol.states.PLAY,
    version: "1.21.11",
  });
  const parsed = deserializer.parsePacketBuffer(
    setSlotPacketWithZeroDamageTypeHolder(),
  );

  assert.equal(parsed.data.name, "set_slot");
  assert.deepEqual(parsed.data.params.item.components[0], {
    type: "damage_type",
    data: { hasHolder: true, damageType: 0 },
  });
});

test("patches 1.21.11 variant components to EitherHolder wire shape", () => {
  patchMinecraftDataProtocol("1.21.11");
  const data = require("minecraft-data")("1.21.11");
  const slotFields = data.protocol.types.SlotComponent[1];
  const dataField = slotFields.find((field) => field.name === "data");
  const componentTypes = dataField.type[1].fields;

  for (const componentName of ["chicken/variant", "zombie_nautilus/variant"]) {
    assert.equal(componentTypes[componentName][0], "container");
    assert.deepEqual(componentTypes[componentName][1], [
      { name: "hasHolder", type: "bool" },
      {
        name: "variant",
        type: [
          "switch",
          {
            compareTo: "hasHolder",
            fields: { true: "varint", false: "string" },
          },
        ],
      },
    ]);
  }
});
