'use strict';

/**
 * Empty Babel preset used while Jest still depends on
 * `babel-preset-current-node-syntax` (via babel-preset-jest / jest-snapshot).
 *
 * Babel 8's parser already understands the syntax those legacy
 * `@babel/plugin-syntax-*` packages enabled; those plugins declare
 * `peerDependencies.@babel/core: ^7.0.0-0` and make `npm ls` fail with
 * Babel 8. This stand-in keeps the Jest/Babel 8 graph valid without
 * `--force` / `--legacy-peer-deps`.
 *
 * @returns {{ plugins: [] }}
 */
module.exports = function babelPresetCurrentNodeSyntax() {
  return { plugins: [] };
};
