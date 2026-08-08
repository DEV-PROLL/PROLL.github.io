import { Platform, StyleSheet } from "react-native";
import type { ViewStyle } from "react-native";
import { theme } from "../theme";

export const webHoldSafeStyle: ViewStyle =
  Platform.OS === "web"
    ? ({
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        touchAction: "none",
      } as unknown as ViewStyle)
    : {};

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
  controls: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 12,
  },
  dpad: { flex: 1, gap: 8 },
  dpadRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  controlSpacer: { width: 58, height: 58 },
  actionControls: {
    width: 116,
    gap: 8,
  },
  control: {
    width: 58,
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: theme.cardElevated,
  },
  actionControl: { width: "100%", height: 62 },
  controlPressed: {
    borderColor: theme.accentSoft,
    backgroundColor: theme.accentMuted,
    transform: [{ scale: 0.97 }],
  },
  controlDisabled: { opacity: 0.4 },
  controlLabel: { color: theme.text, fontSize: 20, fontWeight: "900" },
  controlLabelPressed: { color: "#fff" },
  controlHint: { color: theme.textDim, fontSize: 10, fontWeight: "700", marginTop: 3 },
  stop: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.danger,
    backgroundColor: "rgba(248,81,73,.12)",
  },
  stopPressed: {
    backgroundColor: theme.danger,
    transform: [{ scale: 0.985 }],
  },
  stopText: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "900",
  },
});
