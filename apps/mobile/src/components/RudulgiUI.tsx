import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { theme } from "../theme";

interface GlassPanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function GlassPanel({ children, style }: GlassPanelProps) {
  return <View style={[styles.glassPanel, style]}>{children}</View>;
}

interface PrimaryButtonProps {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

export function PrimaryButton({
  children,
  onPress,
  disabled = false,
  loading = false,
  variant = "primary",
  style,
  textStyle,
}: PrimaryButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`${variant}Button`],
        pressed && !inactive ? styles.buttonPressed : null,
        inactive ? styles.buttonDisabled : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={theme.text} />
      ) : (
        <Text style={[styles.buttonText, styles[`${variant}ButtonText`], textStyle]}>
          {children}
        </Text>
      )}
    </Pressable>
  );
}

interface StatusPillProps {
  label: string;
  tone?: "online" | "warning" | "error" | "neutral";
  style?: StyleProp<ViewStyle>;
}

export function StatusPill({ label, tone = "neutral", style }: StatusPillProps) {
  const color = toneColor(tone);
  return (
    <View style={[styles.pill, { borderColor: color }, style]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

interface MinecraftHeadProps {
  uuid?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function MinecraftHead({ uuid, size = 48, style }: MinecraftHeadProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedUuid = uuid?.trim();

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedUuid]);

  if (normalizedUuid && !imageFailed) {
    return (
      <View
        style={[
          styles.headFrame,
          {
            width: size,
            height: size,
            borderRadius: Math.max(8, size * 0.18),
          },
          style,
        ]}
      >
        <Image
          source={{
            uri: `https://crafatar.com/avatars/${normalizedUuid}?size=${Math.max(
              64,
              Math.round(size * 2),
            )}&overlay`,
          }}
          onError={() => setImageFailed(true)}
          style={styles.headImage}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.headFrame,
        styles.headFallback,
        {
          width: size,
          height: size,
          borderRadius: Math.max(8, size * 0.18),
        },
        style,
      ]}
    >
      <View style={[styles.skinBase, StyleSheet.absoluteFill]} />
      <View style={[styles.hair, { height: size * 0.35 }]} />
      <View
        style={[
          styles.eye,
          {
            width: size * 0.12,
            height: size * 0.18,
            left: size * 0.24,
            top: size * 0.45,
          },
        ]}
      />
      <View
        style={[
          styles.eye,
          {
            width: size * 0.12,
            height: size * 0.18,
            right: size * 0.24,
            top: size * 0.45,
          },
        ]}
      />
      <View
        style={[
          styles.chinShadow,
          {
            height: size * 0.14,
          },
        ]}
      />
    </View>
  );
}

function toneColor(tone: NonNullable<StatusPillProps["tone"]>) {
  switch (tone) {
    case "online":
      return theme.accent;
    case "warning":
      return "#d29922";
    case "error":
      return theme.danger;
    default:
      return theme.textDim;
  }
}

const styles = StyleSheet.create({
  glassPanel: {
    backgroundColor: theme.glass,
    borderColor: theme.glassBorder,
    borderWidth: 1,
    borderRadius: 26,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 18 },
  },
  button: {
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    paddingHorizontal: 18,
    transform: [{ scale: 1 }],
  },
  primaryButton: {
    backgroundColor: theme.accentMuted,
    borderColor: "rgba(126, 231, 135, 0.5)",
  },
  secondaryButton: {
    backgroundColor: theme.cardElevated,
    borderColor: theme.glassBorder,
  },
  ghostButton: {
    backgroundColor: "transparent",
    borderColor: "transparent",
  },
  buttonPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "800",
  },
  primaryButtonText: {
    color: theme.text,
  },
  secondaryButtonText: {
    color: theme.text,
  },
  ghostButtonText: {
    color: theme.textDim,
  },
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: "rgba(13, 17, 23, 0.58)",
  },
  pillDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 6,
  },
  pillText: {
    fontSize: 12,
    fontWeight: "800",
  },
  headFrame: {
    overflow: "hidden",
    backgroundColor: theme.cardElevated,
    borderColor: theme.glassBorder,
    borderWidth: 1,
  },
  headImage: {
    width: "100%",
    height: "100%",
  },
  headFallback: {
    backgroundColor: "#d8ad74",
  },
  skinBase: {
    backgroundColor: "#f0c78e",
  },
  hair: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "#8a6747",
  },
  eye: {
    position: "absolute",
    backgroundColor: "#111820",
  },
  chinShadow: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(111, 78, 46, 0.24)",
  },
});
