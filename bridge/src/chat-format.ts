// Minecraft sends chat as a JSON tree with translation keys, color, etc.
// mineflayer surfaces it as a ChatMessage. We extract two things:
//   - plain text for clients that just want to display it
//   - the raw JSON for clients that want to render colors/styles themselves

interface AnyChatMessage {
  toString(): string;
  toMotd?: () => string;
  json?: unknown;
}

export interface ChatSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  clickEvent?: {
    action: string;
    value: string;
  };
  hoverText?: string;
}

interface SegmentStyle {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  clickEvent?: {
    action: string;
    value: string;
  };
  hoverText?: string;
}

const MC_COLORS: Record<string, string> = {
  black: "#000000",
  dark_blue: "#0000aa",
  dark_green: "#00aa00",
  dark_aqua: "#00aaaa",
  dark_red: "#aa0000",
  dark_purple: "#aa00aa",
  gold: "#ffaa00",
  gray: "#aaaaaa",
  dark_gray: "#555555",
  blue: "#5555ff",
  green: "#55ff55",
  aqua: "#55ffff",
  red: "#ff5555",
  light_purple: "#ff55ff",
  yellow: "#ffff55",
  white: "#ffffff",
};

const LEGACY_COLORS: Record<string, string> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff",
};

const TRANSLATIONS: Record<string, string> = {
  "chat.type.text": "<%1$s> %2$s",
  "chat.type.announcement": "[%1$s] %2$s",
  "chat.type.admin": "[%1$s: %2$s]",
  "chat.type.advancement.task": "%1$s has made the advancement %2$s",
  "chat.type.advancement.goal": "%1$s has reached the goal %2$s",
  "chat.type.advancement.challenge": "%1$s has completed the challenge %2$s",
  "death.attack.generic": "%1$s died",
  "death.attack.player": "%1$s was slain by %2$s",
  "death.attack.mob": "%1$s was slain by %2$s",
  "death.attack.arrow": "%1$s was shot by %2$s",
  "death.attack.trident": "%1$s was impaled by %2$s",
  "death.attack.thrown": "%1$s was pummeled by %2$s",
  "death.attack.explosion": "%1$s blew up",
  "death.attack.explosion.player": "%1$s was blown up by %2$s",
  "death.attack.magic": "%1$s was killed by magic",
  "death.attack.wither": "%1$s withered away",
  "death.attack.outOfWorld": "%1$s fell out of the world",
  "death.attack.fell.accident.generic": "%1$s hit the ground too hard",
  "death.fell.accident.generic": "%1$s fell from a high place",
  "death.attack.fall": "%1$s hit the ground too hard",
  "death.attack.inFire": "%1$s went up in flames",
  "death.attack.onFire": "%1$s burned to death",
  "death.attack.lava": "%1$s tried to swim in lava",
  "death.attack.drown": "%1$s drowned",
  "death.attack.starve": "%1$s starved to death",
  "death.attack.cactus": "%1$s was pricked to death",
  "death.attack.freeze": "%1$s froze to death",
  "death.attack.lightningBolt": "%1$s was struck by lightning",
  "death.attack.flyIntoWall": "%1$s experienced kinetic energy",
  "death.attack.cramming": "%1$s was squished too much",
  "death.attack.dryout": "%1$s dried out",
  "death.attack.sweetBerryBush": "%1$s was poked to death by a sweet berry bush",
  "death.attack.stalagmite": "%1$s was impaled on a stalagmite",
  "death.attack.fallingBlock": "%1$s was squashed by a falling block",
  "death.attack.anvil": "%1$s was squashed by a falling anvil",
};

export function plainText(msg: AnyChatMessage | string | undefined | null): string {
  if (msg == null) return "";
  if (typeof msg === "string") return replaceBrokenGlyphs(msg);
  try {
    return replaceBrokenGlyphs(msg.toString());
  } catch {
    return "";
  }
}

export function rawJson(msg: AnyChatMessage | string | undefined | null): unknown {
  if (msg == null) return undefined;
  if (typeof msg === "string") return undefined;
  return msg.json;
}

export function richSegments(msg: AnyChatMessage | string | undefined | null): ChatSegment[] | undefined {
  if (msg == null) return undefined;
  if (typeof msg === "string") return [{ text: msg }];
  const source = msg.json ?? msg;
  const segments = flattenComponent(source, {}).flatMap(splitLegacyCodes);
  const merged = mergeAdjacentSegments(segments).filter((segment) => segment.text.length > 0);
  return merged.length > 0 ? merged : undefined;
}

export function componentPlainText(value: unknown): string {
  const source = parseTextComponent(value);
  const segments = flattenComponent(source, {}).flatMap(splitLegacyCodes);
  const text = segments.map((segment) => segment.text).join("");
  return replaceBrokenGlyphs(text).trim();
}

// Extract the speaker name when the chat is a `chat.type.text` translation
// (vanilla format: `<player> message`). For system messages this returns null.
export function extractSender(msg: AnyChatMessage | string | undefined | null): string | null {
  if (msg == null || typeof msg === "string") return null;
  const j = (msg.json as { translate?: string; with?: unknown[] } | undefined);
  if (!j || j.translate !== "chat.type.text") return null;
  const sender = j.with?.[0];
  if (typeof sender === "string") return sender;
  if (sender && typeof sender === "object") {
    const obj = sender as { text?: string; insertion?: string };
    return obj.text ?? obj.insertion ?? null;
  }
  return null;
}

function flattenComponent(value: unknown, inherited: SegmentStyle): ChatSegment[] {
  if (value == null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ ...inherited, text: replaceBrokenGlyphs(String(value)) }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenComponent(item, inherited));
  }
  if (typeof value !== "object") return [];

  const component = value as {
    "": unknown;
    text?: unknown;
    translate?: unknown;
    with?: unknown;
    extra?: unknown;
    color?: unknown;
    bold?: unknown;
    italic?: unknown;
    underlined?: unknown;
    strikethrough?: unknown;
    clickEvent?: unknown;
    click_event?: unknown;
    hoverEvent?: unknown;
    hover_event?: unknown;
  };
  const style = inheritStyle(component, inherited);
  const segments: ChatSegment[] = [];

  if (component.text != null) {
    segments.push(...flattenComponent(component.text, style));
  } else if (component[""] != null) {
    segments.push(...flattenComponent(component[""], style));
  } else if (typeof component.translate === "string") {
    segments.push(...flattenTranslate(component.translate, component.with, style));
  }

  if (Array.isArray(component.extra)) {
    segments.push(...component.extra.flatMap((item) => flattenComponent(item, style)));
  }

  return segments;
}

function inheritStyle(component: {
  color?: unknown;
  bold?: unknown;
  italic?: unknown;
  underlined?: unknown;
  strikethrough?: unknown;
  clickEvent?: unknown;
  click_event?: unknown;
  hoverEvent?: unknown;
  hover_event?: unknown;
}, inherited: SegmentStyle): SegmentStyle {
  return {
    ...inherited,
    color: normalizeColor(component.color) ?? inherited.color,
    bold: typeof component.bold === "boolean" ? component.bold : inherited.bold,
    italic: typeof component.italic === "boolean" ? component.italic : inherited.italic,
    underlined:
      typeof component.underlined === "boolean"
        ? component.underlined
        : inherited.underlined,
    strikethrough:
      typeof component.strikethrough === "boolean"
        ? component.strikethrough
        : inherited.strikethrough,
    clickEvent:
      normalizeClickEvent(component.clickEvent ?? component.click_event) ??
      inherited.clickEvent,
    hoverText:
      normalizeHoverText(component.hoverEvent ?? component.hover_event) ??
      inherited.hoverText,
  };
}

function flattenTranslate(translate: string, withValue: unknown, style: SegmentStyle): ChatSegment[] {
  const args = Array.isArray(withValue) ? withValue : [];
  const template = TRANSLATIONS[translate] ?? fallbackTranslation(translate, args.length);
  if (template) {
    return applyTranslationTemplate(template, args, style);
  }
  if (args.length === 0) return [{ ...style, text: translate }];

  const segments: ChatSegment[] = [{ ...style, text: `${translate} ` }];
  args.forEach((arg, index) => {
    if (index > 0) segments.push({ ...style, text: " " });
    segments.push(...flattenComponent(arg, style));
  });
  return segments;
}

function fallbackTranslation(translate: string, argCount: number): string | null {
  if (argCount === 0) return null;
  if (translate.startsWith("death.attack.") || translate.startsWith("death.")) {
    return argCount >= 2 ? "%1$s died (%2$s)" : "%1$s died";
  }
  return null;
}

function applyTranslationTemplate(
  template: string,
  args: unknown[],
  style: SegmentStyle,
): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let cursor = 0;
  let sequentialIndex = 0;
  const placeholder = /%((\d+)\$)?s/g;
  let match: RegExpExecArray | null;
  while ((match = placeholder.exec(template)) != null) {
    if (match.index > cursor) {
      segments.push({ ...style, text: template.slice(cursor, match.index) });
    }
    const argIndex = match[2] ? Number(match[2]) - 1 : sequentialIndex++;
    if (args[argIndex] != null) {
      segments.push(...flattenComponent(args[argIndex], style));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) {
    segments.push({ ...style, text: template.slice(cursor) });
  }
  return segments;
}

function parseTextComponent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return MC_COLORS[color];
}

function normalizeClickEvent(value: unknown): SegmentStyle["clickEvent"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as { action?: unknown; value?: unknown; command?: unknown; url?: unknown };
  if (typeof obj.action !== "string") return undefined;
  const eventValue =
    typeof obj.value === "string"
      ? obj.value
      : typeof obj.command === "string"
        ? obj.command
        : typeof obj.url === "string"
          ? obj.url
          : undefined;
  if (!eventValue) return undefined;
  return { action: obj.action, value: eventValue };
}

function normalizeHoverText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as { action?: unknown; value?: unknown; contents?: unknown };
  const source = obj.contents ?? obj.value;
  const text = flattenComponent(source, {})
    .map((segment) => segment.text)
    .join("");
  return text || undefined;
}

function mergeAdjacentSegments(segments: ChatSegment[]): ChatSegment[] {
  const merged: ChatSegment[] = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyle(prev, segment)) {
      prev.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function sameStyle(a: ChatSegment, b: ChatSegment): boolean {
  return (
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underlined === b.underlined &&
    a.strikethrough === b.strikethrough &&
    a.hoverText === b.hoverText &&
    a.clickEvent?.action === b.clickEvent?.action &&
    a.clickEvent?.value === b.clickEvent?.value
  );
}

function splitLegacyCodes(segment: ChatSegment): ChatSegment[] {
  if (!segment.text.includes("§")) return [segment];

  const segments: ChatSegment[] = [];
  let style: Omit<ChatSegment, "text"> = { ...segment };
  let buffer = "";

  const flush = () => {
    if (buffer) {
      segments.push({ ...style, text: replaceBrokenGlyphs(buffer) });
      buffer = "";
    }
  };

  for (let i = 0; i < segment.text.length; i += 1) {
    const ch = segment.text[i];
    if (ch !== "§" || i + 1 >= segment.text.length) {
      buffer += ch;
      continue;
    }

    const code = segment.text[i + 1].toLowerCase();
    i += 1;
    flush();

    if (code === "x") {
      const hex = readLegacyHexColor(segment.text, i + 1);
      if (hex) {
        style = {
          ...style,
          color: hex,
          bold: false,
          italic: false,
          underlined: false,
          strikethrough: false,
        };
        i += 12;
        continue;
      }
    }

    if (LEGACY_COLORS[code]) {
      style = {
        ...style,
        color: LEGACY_COLORS[code],
        bold: false,
        italic: false,
        underlined: false,
        strikethrough: false,
      };
      continue;
    }

    switch (code) {
      case "l":
        style = { ...style, bold: true };
        break;
      case "o":
        style = { ...style, italic: true };
        break;
      case "n":
        style = { ...style, underlined: true };
        break;
      case "m":
        style = { ...style, strikethrough: true };
        break;
      case "r":
        style = {};
        break;
      default:
        break;
    }
  }

  flush();
  return segments;
}

function readLegacyHexColor(text: string, start: number): string | null {
  let hex = "";
  for (let index = 0; index < 6; index += 1) {
    const section = text[start + index * 2];
    const digit = text[start + index * 2 + 1];
    if (section !== "§" || !digit || !/[0-9a-f]/i.test(digit)) return null;
    hex += digit;
  }
  return `#${hex.toLowerCase()}`;
}

function replaceBrokenGlyphs(text: string): string {
  // If the protocol layer has already produced replacement characters, render
  // a stable placeholder instead of a run of unreadable diamonds.
  return text.replace(/\uFFFD{2,}/g, "◆").replace(/\uFFFD/g, "◆");
}
