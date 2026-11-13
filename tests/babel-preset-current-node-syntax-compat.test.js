'use strict';

const preset = require('../tooling/babel-preset-current-node-syntax-compat');

describe('babel-preset-current-node-syntax Babel 8 compat stand-in', () => {
  test('exports an empty plugins list (Babel 8 parser covers legacy syntax plugins)', () => {
    expect(preset()).toEqual({ plugins: [] });
  });

  test('declares Babel 7 and Babel 8 core peers', () => {
    const pkg = require('../tooling/babel-preset-current-node-syntax-compat/package.json');
    expect(pkg.name).toBe('babel-preset-current-node-syntax');
    expect(pkg.peerDependencies['@babel/core']).toBe('^7.0.0 || ^8.0.0');
  });
});
