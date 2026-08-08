import { useEffect, useMemo, useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { HEAD_RENDER_ENABLED } from "../appConfig";
import {
  MINECRAFT_ASSETS_BASE_URL,
  minecraftSkinAspectRatio,
  minecraftTextureUrls,
  normalizeMinecraftAssetName,
  playerHeadTextureTiers,
  type PlayerHeadMetadata,
  type PlayerHeadTextureTier,
} from "../itemTextures";

interface MinecraftItemIconProps {
  readonly itemName: string;
  readonly mcVersion: string;
  readonly head?: PlayerHeadMetadata;
  readonly fallbackLabel: string;
  readonly fallbackColor: string;
  readonly size?: number;
  readonly style?: StyleProp<ViewStyle>;
}

export function MinecraftItemIcon({
  itemName,
  mcVersion,
  head,
  fallbackLabel,
  fallbackColor,
  size = 24,
  style,
}: MinecraftItemIconProps) {
  const textureSources = useMemo<readonly IconSource[]>(() => {
    const normalizedItemName = normalizeMinecraftAssetName(itemName);
    const isPlayerHead =
      normalizedItemName === "player_head" ||
      normalizedItemName === "player_wall_head";
    const headSources =
      HEAD_RENDER_ENABLED && isPlayerHead
        ? playerHeadTextureTiers(head)
        : [];
    const itemSources = minecraftTextureUrls(
      MINECRAFT_ASSETS_BASE_URL,
      mcVersion,
      itemName,
    ).map((url): IconSource => ({ kind: "item", url }));
    return [...headSources, ...itemSources];
  }, [
    head?.playerName,
    head?.playerUuid,
    head?.textureId,
    itemName,
    mcVersion,
  ]);
  const sourceSignature = textureSources
    .map((source) => `${source.kind}:${source.url}`)
    .join("|");
  const [textureIndex, setTextureIndex] = useState(0);
  const [textureLoaded, setTextureLoaded] = useState(false);
  const textureSource = textureSources[textureIndex];

  useEffect(() => {
    setTextureIndex(0);
    setTextureLoaded(false);
  }, [sourceSignature]);

  const handleLoad = () => setTextureLoaded(true);
  const handleError = () => {
    setTextureLoaded(false);
    setTextureIndex((current) => current + 1);
  };

  return (
    <View style={[styles.frame, { width: size, height: size }, style]}>
      <View
        style={[
          styles.fallback,
          { backgroundColor: fallbackColor },
          textureLoaded ? styles.hidden : null,
        ]}
      >
        <Text
          style={[styles.fallbackText, { fontSize: Math.max(9, size * 0.38) }]}
          numberOfLines={1}
        >
          {fallbackLabel}
        </Text>
      </View>
      {textureSource?.kind === "skin" ? (
        <PlayerSkinFace
          key={textureSource.url}
          url={textureSource.url}
          size={size}
          loaded={textureLoaded}
          onLoad={handleLoad}
          onError={handleError}
        />
      ) : textureSource ? (
        <Image
          key={textureSource.url}
          source={{ uri: textureSource.url }}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          onLoad={handleLoad}
          onError={handleError}
          style={[styles.texture, textureLoaded ? null : styles.hidden]}
        />
      ) : null}
    </View>
  );
}

type IconSource =
  | PlayerHeadTextureTier
  | {
      readonly kind: "item";
      readonly url: string;
    };

function PlayerSkinFace({
  url,
  size,
  loaded,
  onLoad,
  onError,
}: {
  readonly url: string;
  readonly size: number;
  readonly loaded: boolean;
  readonly onLoad: () => void;
  readonly onError: () => void;
}) {
  const imageSize = size * 8;
  const [sourceAspectRatio, setSourceAspectRatio] = useState<0.5 | 1>(1);

  useEffect(() => {
    let active = true;
    setSourceAspectRatio(1);
    Image.getSize(
      url,
      (sourceWidth, sourceHeight) => {
        if (active) {
          setSourceAspectRatio(
            minecraftSkinAspectRatio(sourceWidth, sourceHeight),
          );
        }
      },
      () => {
        if (active) setSourceAspectRatio(1);
      },
    );
    return () => {
      active = false;
    };
  }, [url]);

  return (
    <View style={[styles.skinCrop, loaded ? null : styles.hidden]}>
      <Image
        source={{ uri: url }}
        resizeMode="stretch"
        accessibilityIgnoresInvertColors
        onLoad={onLoad}
        onError={onError}
        style={[
          pixelatedSkinStyle,
          {
            width: imageSize,
            height: imageSize * sourceAspectRatio,
            left: -size,
            top: -size,
          },
        ]}
      />
      {sourceAspectRatio === 1 ? (
        <Image
          source={{ uri: url }}
          resizeMode="stretch"
          accessibilityIgnoresInvertColors
          style={[
            pixelatedSkinStyle,
            {
              width: imageSize,
              height: imageSize,
              left: -size * 5,
              top: -size,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const pixelatedTextureStyle: ImageStyle & {
  readonly imageRendering: "pixelated";
} = {
  ...StyleSheet.absoluteFillObject,
  width: "100%",
  height: "100%",
  imageRendering: "pixelated",
};

const pixelatedSkinStyle: ImageStyle & {
  readonly imageRendering: "pixelated";
} = {
  position: "absolute",
  imageRendering: "pixelated",
};

const styles = StyleSheet.create({
  frame: {
    flexShrink: 0,
    position: "relative",
  },
  fallback: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  fallbackText: {
    color: "#ffffff",
    fontWeight: "900",
  },
  texture: pixelatedTextureStyle,
  skinCrop: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  hidden: {
    opacity: 0,
  },
});
