import { StyleSheet, type ImageStyle } from "react-native";
import type { MapViewState } from "../mapFrame";
import { theme } from "../theme";

export function statusStyle(state: MapViewState["state"]) {
  switch (state) {
    case "live":
      return styles.statusLive;
    case "stale":
      return styles.statusStale;
    case "loading":
    case "unsupported":
      return styles.statusNeutral;
  }
}

export const pixelatedMapStyle: ImageStyle & {
  readonly imageRendering: "pixelated";
} = {
  width: "100%",
  height: "100%",
  imageRendering: "pixelated",
};

export const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: theme.accent,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.2,
  },
  title: {
    color: theme.text,
    fontSize: 15,
    fontWeight: "900",
    marginTop: 2,
  },
  status: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  statusLive: {
    borderColor: theme.accentMuted,
    backgroundColor: "rgba(35,134,54,.2)",
  },
  statusStale: {
    borderColor: "#d29922",
    backgroundColor: "rgba(210,153,34,.14)",
  },
  statusNeutral: {
    borderColor: theme.borderStrong,
    backgroundColor: theme.cardElevated,
  },
  statusText: {
    color: theme.textDim,
    fontSize: 9,
    fontWeight: "900",
  },
  viewport: {
    position: "relative",
    width: "100%",
    maxWidth: 320,
    aspectRatio: 1,
    alignSelf: "center",
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    backgroundColor: "#05080b",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 14,
    fontWeight: "900",
    textAlign: "center",
  },
  emptyDetail: {
    color: theme.textDim,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 6,
  },
  north: {
    position: "absolute",
    top: 8,
    left: 9,
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    textShadowColor: "#000000",
    textShadowRadius: 3,
  },
  playerMarker: {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 28,
    height: 28,
    marginLeft: -14,
    marginTop: -14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "rgba(13,17,23,.78)",
    borderColor: "#ffffff",
    borderWidth: 1,
  },
  playerArrow: {
    color: theme.accentSoft,
    fontSize: 20,
    lineHeight: 22,
    fontWeight: "900",
  },
  staleOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(13,17,23,.44)",
  },
  caption: {
    color: theme.textDim,
    fontSize: 10,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
});
