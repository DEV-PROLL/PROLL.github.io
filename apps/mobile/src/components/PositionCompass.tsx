import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PlayerPosition } from "../protocol";
import {
  POSITION_FRESH_MS,
  POSITION_STALE_MS,
  minecraftHeadingRotation,
  positionAvailability,
  type PositionAvailability,
} from "../position";
import { theme } from "../theme";

interface PositionCompassProps {
  connected: boolean;
  position: PlayerPosition | null;
}

const STATUS_COPY = {
  fresh: "LIVE",
  aging: "AGING",
  stale: "STALE",
  missing: "WAITING",
  offline: "OFFLINE",
} as const satisfies Record<PositionAvailability, string>;

export function PositionCompass({ connected, position }: PositionCompassProps) {
  const [now, setNow] = useState(Date.now);
  const availability = positionAvailability(connected, position?.ts ?? null, now);
  const statusCopy = STATUS_COPY[availability];

  useEffect(() => {
    setNow(Date.now());
  }, [connected, position?.ts]);

  useEffect(() => {
    if (!connected || !position) return;
    const ageMs = Math.max(0, now - position.ts);
    const nextBoundary =
      ageMs < POSITION_FRESH_MS
        ? position.ts + POSITION_FRESH_MS
        : ageMs < POSITION_STALE_MS
          ? position.ts + POSITION_STALE_MS
          : null;
    if (nextBoundary == null) return;

    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, nextBoundary - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [connected, now, position]);

  const positionCopy = position
    ? `X ${formatCoordinate(position.x)}  Y ${formatCoordinate(position.y)}  Z ${formatCoordinate(position.z)}`
    : "X --  Y --  Z --";
  const direction = position?.direction ?? "--";
  const dimension = formatDimension(position?.dimension);
  const headingRotation = minecraftHeadingRotation(position?.yaw ?? 0);

  return (
    <View
      accessible
      accessibilityLabel={`${positionCopy}, direction ${direction}, dimension ${dimension}, position ${statusCopy}`}
      style={styles.strip}
    >
      <View style={styles.heading}>
        <Text
          style={[
            styles.arrow,
            !position ? styles.arrowHidden : null,
            { transform: [{ rotate: `${headingRotation}deg` }] },
          ]}
        >
          ↑
        </Text>
        <Text style={[styles.direction, !position ? styles.muted : null]}>{direction}</Text>
      </View>

      <Text numberOfLines={1} style={styles.coordinates}>
        {positionCopy}
      </Text>

      <View style={styles.meta}>
        <View style={styles.dimensionBadge}>
          <Text ellipsizeMode="tail" numberOfLines={1} style={styles.dimensionText}>
            {dimension}
          </Text>
        </View>
        <View style={styles.freshness}>
          <View style={[styles.freshnessDot, statusDotStyle(availability)]} />
          <Text style={styles.freshnessText}>{statusCopy}</Text>
        </View>
      </View>
    </View>
  );
}

function formatCoordinate(value: number): string {
  return value.toFixed(1);
}

function formatDimension(dimension?: string): string {
  if (!dimension) return "--";
  const name = dimension.split(":").at(-1) ?? dimension;
  if (name === "the_nether") return "NETHER";
  if (name === "the_end") return "THE END";
  return name.replace(/_/g, " ").toUpperCase();
}

function statusDotStyle(availability: PositionAvailability) {
  switch (availability) {
    case "fresh":
      return styles.dotFresh;
    case "aging":
      return styles.dotAging;
    case "stale":
      return styles.dotStale;
    case "missing":
    case "offline":
      return styles.dotOffline;
  }
}

const styles = StyleSheet.create({
  strip: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 7,
    backgroundColor: "rgba(13, 17, 23, 0.92)",
    borderBottomColor: theme.glassBorder,
    borderBottomWidth: 1,
  },
  heading: {
    width: 30,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  arrow: {
    color: theme.accentSoft,
    fontSize: 19,
    lineHeight: 19,
    fontWeight: "900",
  },
  direction: {
    color: theme.text,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: "900",
    marginTop: 2,
  },
  muted: {
    color: theme.textDim,
  },
  arrowHidden: {
    opacity: 0,
  },
  coordinates: {
    flex: 1,
    minWidth: 0,
    color: theme.text,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  meta: {
    flexShrink: 0,
    alignItems: "flex-end",
    gap: 4,
  },
  dimensionBadge: {
    maxWidth: 84,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: theme.cardElevated,
    borderColor: theme.border,
    borderWidth: 1,
  },
  dimensionText: {
    color: theme.textDim,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "900",
  },
  freshness: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  freshnessDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotFresh: {
    backgroundColor: theme.accentSoft,
  },
  dotAging: {
    backgroundColor: theme.accentMuted,
  },
  dotStale: {
    backgroundColor: theme.danger,
  },
  dotOffline: {
    backgroundColor: theme.textDim,
  },
  freshnessText: {
    color: theme.textDim,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "900",
    letterSpacing: 0.45,
  },
});
