// Metro's transform cache is keyed by file contents and transformer options,
// not by the environment, yet Expo inlines EXPO_PUBLIC_* values at transform
// time. Without this, a build made with EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG=1
// leaves a cached MachineView.tsx that a later plain build reuses, and that
// plain build is debuggable. The flag is part of the cache version, so each
// value has its own cache entries.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.cacheVersion = `${config.cacheVersion}:webview-debug=${process.env.EXPO_PUBLIC_KIVOTOS_WEBVIEW_DEBUG ?? ""}`;

module.exports = config;
