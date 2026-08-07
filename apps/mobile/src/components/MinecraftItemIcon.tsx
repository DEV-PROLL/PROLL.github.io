import { useState } from "react";
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  MINECRAFT_ASSETS_BASE_URL,
  minecraftTextureUrls,
} from "../itemTextures";

interface MinecraftItemIconProps {
  readonly itemName: string;
  readonly mcVersion: string;
  readonly fallbackLabel: string;
  readonly fallbackColor: string;
  readonly size?: number;
  readonly style?: StyleProp<ViewStyle>;
}

export function MinecraftItemIcon({
  itemName,
  mcVersion,
  fallbackLabel,
  fallbackColor,
  size = 24,
  style,
}: MinecraftItemIconProps) {
  const textureUrls = minecraftTextureUrls(
    MINECRAFT_ASSETS_BASE_URL,
    mcVersion,
    itemName,
  );
  const [textureIndex, setTextureIndex] = useState(0);
  const [textureLoaded, setTextureLoaded] = useState(false);
  const textureUrl = textureUrls[textureIndex];

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
      {textureUrl ? (
        <Image
          key={textureUrl}
          source={{ uri: textureUrl }}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
          onLoad={() => setTextureLoaded(true)}
          onError={() => {
            setTextureLoaded(false);
            setTextureIndex((current) => current + 1);
          }}
          style={[styles.texture, textureLoaded ? null : styles.hidden]}
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
  hidden: {
    opacity: 0,
  },
});
