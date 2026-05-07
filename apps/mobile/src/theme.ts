// Dark theme inspired by the ChatCraft reference screenshot.
export const theme = {
  bg: "#0d1117",
  card: "#161b22",
  cardElevated: "#1f2731",
  border: "#30363d",
  text: "#e6edf3",
  textDim: "#8b949e",
  accent: "#3fb950",      // Minecraft green
  accentMuted: "#238636",
  danger: "#f85149",
  systemMsg: "#8b949e",
  myMsg: "#58a6ff",
  otherMsg: "#e6edf3",
  inputBg: "#0d1117",
} as const;

export type Theme = typeof theme;
