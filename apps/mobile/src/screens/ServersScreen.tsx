import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "../theme";
import { getBridgeUrl, setBridgeUrl } from "../store/settings";

interface Props {
  onContinue: (bridgeUrl: string) => void;
}

// Initial screen — collect the bridge URL. In a future version we'd
// support multiple servers (the screenshot's list UI), but MVP tracks one.
export function ServersScreen({ onContinue }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void getBridgeUrl().then((stored) => {
      if (stored) setUrl(stored);
      setLoading(false);
    });
  }, []);

  const handleConnect = async () => {
    const trimmed = url.trim();
    if (!/^wss?:\/\//.test(trimmed)) {
      Alert.alert("Invalid URL", "Bridge URL must start with ws:// or wss://");
      return;
    }
    await setBridgeUrl(trimmed);
    onContinue(trimmed);
  };

  if (loading) return <View style={styles.root} />;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>PROLL</Text>
      <Text style={styles.subtitle}>Minecraft Java mobile chat</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Bridge URL</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="wss://your-bridge.fly.dev"
          placeholderTextColor={theme.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
        />
        <Pressable style={styles.button} onPress={handleConnect}>
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </View>

      <Text style={styles.help}>
        The bridge runs the headless Minecraft client on your behalf. Your
        Microsoft tokens stay on the bridge server only.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.bg,
    padding: 24,
    justifyContent: "center",
  },
  title: {
    color: theme.text,
    fontSize: 36,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: theme.textDim,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 32,
  },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  label: {
    color: theme.textDim,
    fontSize: 12,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: theme.inputBg,
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: theme.accentMuted,
    borderRadius: 8,
    paddingVertical: 12,
    marginTop: 16,
    alignItems: "center",
  },
  buttonText: {
    color: theme.text,
    fontSize: 16,
    fontWeight: "600",
  },
  help: {
    color: theme.textDim,
    fontSize: 12,
    marginTop: 24,
    textAlign: "center",
    lineHeight: 18,
  },
});
