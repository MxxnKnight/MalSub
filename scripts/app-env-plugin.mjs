/** Dev-only plugin (no-op on production builds). */
export function appEnvPlugin() {
  return {
    name: "app-builder:app-env",
    apply: "serve",
    configureServer() {
      // intentionally empty outside Grok sandbox
    },
  };
}
