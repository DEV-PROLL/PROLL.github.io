// Dark theme inspired by the ChatCraft reference screenshot.
export const theme = {
  bg: "#0d1117",
  card: "#161b22",
  cardElevated: "#1f2731",
  glass: "rgba(22, 27, 34, 0.76)",
  glassBorder: "rgba(240, 246, 252, 0.12)",
  border: "#30363d",
  borderStrong: "#6e7681",
  text: "#e6edf3",
  textDim: "#8b949e",
  accent: "#3fb950",      // Minecraft green
  accentSoft: "#7ee787",
  accentMuted: "#238636",
  danger: "#f85149",
  systemMsg: "#8b949e",
  myMsg: "#58a6ff",
  otherMsg: "#e6edf3",
  inputBg: "#0d1117",
  inputGlass: "rgba(13, 17, 23, 0.72)",
} as const;

export type Theme = typeof theme;
