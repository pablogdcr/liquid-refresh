import { StatusBar } from 'expo-status-bar';
import { Suspense } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { PondDemo } from './src/PondDemo';

export default function App() {
  return (
    <View style={styles.container}>
      <Suspense fallback={<Text style={styles.loading}>Initializing GPU…</Text>}>
        <PondDemo />
      </Suspense>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#05070d',
  },
  loading: {
    color: '#8fa3c8',
    textAlign: 'center',
    marginTop: 120,
  },
});
