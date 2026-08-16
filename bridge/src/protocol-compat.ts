type ProtoType = string | [string, unknown];

interface ProtoField {
  name: string;
  type: ProtoType;
}

interface MinecraftDataShape {
  version?: { version?: number };
  protocol?: {
    types?: Record<string, ProtoType>;
  };
}

type MinecraftDataModule = (version: string) => MinecraftDataShape | null;

const minecraftData = require("minecraft-data") as MinecraftDataModule;
const PROTOCOL_1_21_11 = 774;

function containerFields(type: ProtoType | undefined): ProtoField[] | undefined {
  if (!Array.isArray(type) || type[0] !== "container") return undefined;
  return type[1] as unknown as ProtoField[];
}

function namedField(
  fields: ProtoField[] | undefined,
  name: string,
): ProtoField | undefined {
  return fields?.find((field) => field.name === name);
}

function switchFields(type: ProtoType | undefined): Record<string, ProtoType> | undefined {
  if (!Array.isArray(type) || type[0] !== "switch") return undefined;
  return (type[1] as { fields?: Record<string, ProtoType> }).fields;
}

function isRegistryEntryHolder(type: ProtoType | undefined): boolean {
  return Array.isArray(type) && type[0] === "registryEntryHolder";
}

function eitherHolderType(valueName: string): ProtoType {
  return [
    "container",
    [
      { name: "hasHolder", type: "bool" },
      {
        name: valueName,
        type: [
          "switch",
          {
            compareTo: "hasHolder",
            fields: { true: "varint", false: "string" },
          },
        ],
      },
    ],
  ];
}

// minecraft-data 3.113.0 models the new display field once per component.
// Vanilla 1.21.11 encodes it once per attribute entry instead. Without this
// correction every entry after the first is decoded at the wrong byte offset.
export function patchMinecraftDataProtocol(version: string): boolean {
  const data = minecraftData(version);
  if (data?.version?.version !== PROTOCOL_1_21_11) return false;

  const slotFields = containerFields(data.protocol?.types?.SlotComponent);
  const dataField = namedField(slotFields, "data");
  const componentTypes = switchFields(dataField?.type);
  if (!componentTypes) return false;

  let changed = false;

  // These components use EitherHolder.streamCodec in vanilla 1.21.11:
  // a boolean followed by either a plain registry id or a resource key.
  // minecraft-data currently models them as registryEntryHolder, where id 0
  // means inline data. An id-0 item therefore consumes the next bytes as NBT
  // and terminates the client with an "array size is abnormally large" error.
  const damageTypeFields = containerFields(componentTypes.damage_type);
  const damageTypeField = namedField(damageTypeFields, "damageType");
  const damageTypeCases = switchFields(damageTypeField?.type);
  if (damageTypeCases && isRegistryEntryHolder(damageTypeCases.true)) {
    damageTypeCases.true = "varint";
    changed = true;
  }

  for (const componentName of ["chicken/variant", "zombie_nautilus/variant"]) {
    if (isRegistryEntryHolder(componentTypes[componentName])) {
      componentTypes[componentName] = eitherHolderType("variant");
      changed = true;
    }
  }

  const modifierFields = containerFields(
    componentTypes.attribute_modifiers,
  );
  const attributesField = namedField(modifierFields, "attributes");
  const displayField = namedField(modifierFields, "display");
  if (attributesField && displayField && Array.isArray(attributesField.type)) {
    const arrayOptions = attributesField.type[1] as { type?: ProtoType };
    const entryFields = containerFields(arrayOptions.type);
    if (entryFields && !namedField(entryFields, "display")) {
      entryFields.push({ name: "display", type: displayField.type });
      modifierFields?.splice(modifierFields.indexOf(displayField), 1);
      changed = true;
    }
  }

  return changed;
}
