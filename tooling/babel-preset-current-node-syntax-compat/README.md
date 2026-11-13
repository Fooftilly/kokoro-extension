# babel-preset-current-node-syntax (Babel 8 compat stand-in)

Jest 30 still pulls the published `babel-preset-current-node-syntax@1.2.0`, which depends on fifteen `@babel/plugin-syntax-*@7` packages whose peer range is `@babel/core@^7` only. With `@babel/core@8`, that leaves a permanent `npm ls` `invalid` / `ELSPROBLEMS` result even though Jest itself declares Babel 8 peers.

[Babel 8 migration](https://babeljs.io/docs/v8-migration) documents that those syntax plugins are no longer needed — the parser already enables the features. This local package exports an empty preset with `@babel/core@^7 || ^8` peers and is wired through root `package.json` `overrides` (`"$babel-preset-current-node-syntax"`) so transitive Jest consumers resolve here.

Remove this stand-in when upstream Jest / `babel-preset-current-node-syntax` drop the Babel 7-only syntax-plugin dependencies.
