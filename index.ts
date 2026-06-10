import { LogBox } from 'react-native';
import { registerRootComponent } from 'expo';

// react-native-wgpu is a deprecated shim, but @typegpu/react still imports
// from it — silence the rename warning until upstream migrates. This must
// run before the app modules load, hence the explicit require below
// (static imports would hoist above this call).
LogBox.ignoreLogs([/react-native-wgpu/, /Implicit conversions from/]);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const App = require('./App').default;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
