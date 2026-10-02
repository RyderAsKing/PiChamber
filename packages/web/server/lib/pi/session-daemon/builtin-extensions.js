import * as defaultSdk from '@earendil-works/pi-coding-agent';

// Pi ships these as built-in extensions. The Pi CLI loads them itself; SDK
// hosts have to pass them to the resource loader. The names match the CLI's
// list (packages/coding-agent/src/extensions/index.ts upstream), so each one
// loads as `builtin:<name>`.
export const LOADED_BUILTIN_EXTENSIONS = Object.freeze([
  Object.freeze({ name: 'codemode', create: 'createCodemodeExtension' }),
  Object.freeze({ name: 'tool-search', create: 'createToolSearchExtension' }),
  Object.freeze({ name: 'mcp', create: 'createMcpExtension' }),
]);

// Built-ins the Pi CLI loads that PiChamber leaves out on purpose. The SDK
// upgrade test fails when Pi ships a built-in that is in neither list.
export const SKIPPED_BUILTIN_EXTENSIONS = Object.freeze({
  'llama.cpp': 'The SDK does not export a factory for it, and its setup screen needs the Pi TUI.',
});

/**
 * Built-in extension entries for `resourceLoaderOptions.extensionFactories`.
 *
 * `builtin: true` makes `-builtin:<name>` in the Pi `extensions` setting
 * disable an entry. `replaceable: true` makes Pi leave an entry out when an
 * installed extension registers the same tool, command, or flag, for example
 * a third-party MCP extension that registers `/mcp`.
 *
 * A factory the SDK does not provide is skipped, which keeps SDK test doubles
 * working.
 */
export function getBuiltinExtensionFactories(sdk = defaultSdk) {
  const factories = [];
  for (const { name, create } of LOADED_BUILTIN_EXTENSIONS) {
    if (typeof sdk?.[create] !== 'function') continue;
    factories.push({ name, factory: sdk[create](), replaceable: true, builtin: true });
  }
  return factories;
}
