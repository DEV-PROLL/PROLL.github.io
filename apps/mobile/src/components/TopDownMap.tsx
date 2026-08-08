import { useMemo } from "react";
import {
  Image,
  Platform,
  Text,
  View,
} from "react-native";
import { mapFrameRgba, type MapViewState } from "../mapFrame";
import { minecraftHeadingRotation } from "../position";
import type { MapFrame, PlayerPosition } from "../protocol";
import {
  pixelatedMapStyle,
  statusStyle,
  styles,
} from "./TopDownMap.styles";

interface TopDownMapProps {
  readonly map: MapViewState;
  readonly position: PlayerPosition | null;
}

export function TopDownMap({ map, position }: TopDownMapProps) {
  const imageUri = useMemo(
    () => (map.frame ? mapFrameDataUri(map.frame) : null),
    [map.frame],
  );
  const heading = minecraftHeadingRotation(
    position?.yaw ?? map.frame?.heading ?? 0,
  );
  const status = imageUri
    ? map.state
    : map.state === "live"
      ? "unsupported"
      : map.state;

  return (
    <View
      accessible
      accessibilityLabel={`Top-down map ${status}`}
      style={styles.card}
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>LOADED CHUNKS</Text>
          <Text style={styles.title}>주변 지도</Text>
        </View>
        <View style={[styles.status, statusStyle(status)]}>
          <Text style={styles.statusText}>{status.toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.viewport}>
        {imageUri ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="stretch"
            source={{ uri: imageUri }}
            style={pixelatedMapStyle}
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{emptyTitle(status)}</Text>
            <Text style={styles.emptyDetail}>
              {emptyDetail(status, map.reason)}
            </Text>
          </View>
        )}
        {imageUri ? (
          <>
            <Text style={styles.north}>N</Text>
            <View style={styles.playerMarker}>
              <Text
                style={[
                  styles.playerArrow,
                  { transform: [{ rotate: `${heading}deg` }] },
                ]}
              >
                ↑
              </Text>
            </View>
            {status === "stale" ? (
              <View pointerEvents="none" style={styles.staleOverlay} />
            ) : null}
          </>
        ) : null}
      </View>

      {map.frame ? (
        <Text style={styles.caption}>
          X {map.frame.centerX} · Z {map.frame.centerZ} · STEP{" "}
          {map.frame.step}
        </Text>
      ) : null}
    </View>
  );
}

function mapFrameDataUri(frame: MapFrame): string | null {
  if (
    Platform.OS !== "web" ||
    typeof document === "undefined"
  ) {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = frame.cols;
    canvas.height = frame.rows;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const image = context.createImageData(frame.cols, frame.rows);
    image.data.set(mapFrameRgba(frame));
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function emptyTitle(state: MapViewState["state"]): string {
  switch (state) {
    case "loading":
      return "지도 준비 중";
    case "live":
      return "지도를 표시할 수 없음";
    case "stale":
      return "지도 갱신 대기";
    case "unsupported":
      return "지도 사용 불가";
  }
}

function emptyDetail(
  state: MapViewState["state"],
  reason: string | undefined,
): string {
  if (Platform.OS !== "web") return "웹 앱에서 주변 지도를 확인할 수 있어요.";
  if (state === "loading") return "이미 로드된 청크를 확인하고 있어요.";
  if (reason === "capacity") return "현재 지도 구독이 모두 사용 중이에요.";
  if (reason === "no-loaded-chunks") return "현재 위치에 로드된 청크가 없어요.";
  return "위치가 바뀌면 다시 시도해 주세요.";
}
