type ProtoType = string | [string, Record<string, unknown>];

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

// minecraft-data 3.113.0 models the new display field once per component.
// Vanilla 1.21.11 encodes it once per attribute entry instead. Without this
// correction every entry after the first is decoded at the wrong byte offset.
export function patchMinecraftDataProtocol(version: string): boolean {
  const data = minecraftData(version);
  if (data?.version?.version !== PROTOCOL_1_21_11) return false;

  const slotFields = containerFields(data.protocol?.types?.SlotComponent);
  const dataField = namedField(slotFields, "data");
  if (!Array.isArray(dataField?.type) || dataField.type[0] !== "switch") return false;

  const switchOptions = dataField.type[1] as {
    fields?: Record<string, ProtoType>;
  };
  const modifierFields = containerFields(
    switchOptions.fields?.attribute_modifiers,
  );
  const attributesField = namedField(modifierFields, "attributes");
  const displayField = namedField(modifierFields, "display");
  if (!attributesField || !displayField || !Array.isArray(attributesField.type)) return false;

  const arrayOptions = attributesField.type[1] as { type?: ProtoType };
  const entryFields = containerFields(arrayOptions.type);
  if (!entryFields || namedField(entryFields, "display")) return false;

  entryFields.push({ name: "display", type: displayField.type });
  modifierFields?.splice(modifierFields.indexOf(displayField), 1);
  return true;
}
