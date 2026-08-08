import { StyleSheet } from "react-native";
import { theme } from "../theme";

export const styles = StyleSheet.create({
  panel: {
    gap: 14,
    padding: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: theme.card,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  eyebrow: {
    color: theme.accent,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.5,
  },
  heading: { color: theme.text, fontSize: 20, fontWeight: "900", marginTop: 2 },
  status: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusOnline: {
    borderColor: theme.accentMuted,
    backgroundColor: "rgba(35,134,54,.2)",
  },
  statusText: { color: theme.textDim, fontSize: 10, fontWeight: "900" },
  position: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
    padding: 12,
  },
  coordinates: { color: theme.text, fontSize: 15, fontWeight: "800" },
  meta: { color: theme.textDim, fontSize: 12, fontWeight: "700", marginTop: 5 },
});
