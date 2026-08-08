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
  minecraftSpecialItemTexture,
  minecraftSkinAspectRatio,
  minecraftTextureUrls,
  nextImageTierIndex,
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
    const specialSource = minecraftSpecialItemTexture(
      MINECRAFT_ASSETS_BASE_URL,
      mcVersion,
      itemName,
    );
    const itemSources = minecraftTextureUrls(
      MINECRAFT_ASSETS_BASE_URL,
      mcVersion,
      itemName,
    ).map((url): IconSource => ({ kind: "item", url }));
    return [
      ...headSources,
      ...(specialSource ? [specialSource] : []),
      ...itemSources,
    ];
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
  const [textureIndex, setTextureIndex] = useState<number | null>(
    textureSources.length > 0 ? 0 : null,
  );
  const [textureLoaded, setTextureLoaded] = useState(false);
  const textureSource =
    textureIndex === null ? undefined : textureSources[textureIndex];

  useEffect(() => {
    setTextureIndex(textureSources.length > 0 ? 0 : null);
    setTextureLoaded(false);
  }, [sourceSignature, textureSources.length]);

  const handleLoad = () => setTextureLoaded(true);
  const handleError = () => {
    setTextureLoaded(false);
    setTextureIndex((current) =>
      nextImageTierIndex(current, textureSources.length),
    );
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
      ) : textureSource?.kind === "chest" ? (
        <ChestTextureIcon
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
    }
  | {
      readonly kind: "chest";
      readonly url: string;
    };

function ChestTextureIcon({
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
  const faceWidth = size * 0.82;
  const scale = faceWidth / 14;
  const lidHeight = scale * 5;
  const bodyHeight = scale * 10;
  const atlasSize = scale * 64;
  const cropStyle = {
    width: atlasSize,
    height: atlasSize,
    left: -14 * scale,
  } as const;

  return (
    <View style={[styles.chest, loaded ? null : styles.hidden]}>
      <View style={[styles.chestLid, { width: faceWidth, height: lidHeight }]}>
        <Image
          source={{ uri: url }}
          resizeMode="stretch"
          accessibilityIgnoresInvertColors
          onLoad={onLoad}
          onError={onError}
          style={[pixelatedChestStyle, cropStyle, { top: -10 * scale }]}
        />
      </View>
      <View style={[styles.chestBody, { width: faceWidth, height: bodyHeight }]}>
        <Image
          source={{ uri: url }}
          resizeMode="stretch"
          accessibilityIgnoresInvertColors
          style={[pixelatedChestStyle, cropStyle, { top: -33 * scale }]}
        />
      </View>
      <View
        style={[
          styles.chestLatch,
          {
            width: Math.max(2, scale * 2),
            height: Math.max(3, scale * 4),
            top: (size - lidHeight - bodyHeight) / 2 + lidHeight - scale,
          },
        ]}
      />
    </View>
  );
}

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
      <Image
        source={{ uri: url }}
        resizeMode="stretch"
        accessibilityIgnoresInvertColors
        style={[
          pixelatedSkinStyle,
          {
            width: imageSize,
            height: imageSize * sourceAspectRatio,
            left: -size * 5,
            top: -size,
          },
        ]}
      />
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

const pixelatedChestStyle: ImageStyle & {
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
  chest: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  chestLid: {
    overflow: "hidden",
  },
  chestBody: {
    overflow: "hidden",
  },
  chestLatch: {
    position: "absolute",
    alignSelf: "center",
    borderRadius: 1,
    backgroundColor: "#d7d7d7",
    borderWidth: 1,
    borderColor: "#6f6f6f",
  },
  hidden: {
    opacity: 0,
  },
});
