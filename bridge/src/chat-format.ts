// Minecraft sends chat as a JSON tree with translation keys, color, etc.
// mineflayer surfaces it as a ChatMessage. We extract two things:
//   - plain text for clients that just want to display it
//   - the raw JSON for clients that want to render colors/styles themselves

interface AnyChatMessage {
  toString(): string;
  toMotd?: () => string;
  json?: unknown;
}

export function plainText(msg: AnyChatMessage | string | undefined | null): string {
  if (msg == null) return "";
  if (typeof msg === "string") return msg;
  try {
    return msg.toString();
  } catch {
    return "";
  }
}

export function rawJson(msg: AnyChatMessage | string | undefined | null): unknown {
  if (msg == null) return undefined;
  if (typeof msg === "string") return undefined;
  return msg.json;
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
