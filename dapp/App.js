import React from 'react';
import { StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { WebView } from 'react-native-webview';

const DAPP_URL = 'https://dlbtrust-app.fly.dev/dapp';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <WebView
        source={{ uri: DAPP_URL }}
        style={styles.webview}
        originWhitelist={['https://*', 'http://*']}
        allowsInlineMediaPlayback
        javaScriptEnabled
        domStorageEnabled
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f19' },
  webview: { flex: 1, backgroundColor: '#0b0f19' },
});
