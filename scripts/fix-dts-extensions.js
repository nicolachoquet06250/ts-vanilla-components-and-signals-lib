// Small post-build script to adjust TypeScript declaration re-exports.
// Goal: keep runtime .js extensions in dist/*.js, but use .ts extensions in dist/index.d.ts
// so that `export * from './lib/xxx.ts'` appears in the d.ts as requested.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const target = resolve(root, 'dist', 'index.d.ts');

if (!existsSync(target)) {
  // Nothing to do if file doesn't exist (e.g., partial builds)
  process.exit(0);
}

const original = readFileSync(target, 'utf8');

// Replace only relative imports that end with .js by .ts
// Examples to handle:
//   export * from './lib/signals.js';
//   export * from './lib/components.js';
//   export * from './plugins/vite-plugin-autocomponent.js';
// Generic regex: capture quote, path, and .js then keep the rest.
const replaced = original.replace(/(from\s+['"])\.\/(?:[^'"\n]+?)\.js(['"];?)/g, (_, p1, p2) => {
  // reconstruct with .ts
  return `${p1}${_.slice(p1.length, _.length - p2.length).replace(/\.js$/, '.ts')}${p2}`;
});

// Simpler and safer approach: do two straightforward replacements for known folders
// in case the generic regex above misses edge cases.
const finalContent = replaced
  .replaceAll("./lib/signals.js", "./lib/signals.ts")
  .replaceAll("./lib/components.js", "./lib/components.ts")
  .replaceAll("./plugins/vite-plugin-autocomponent.js", "./plugins/vite-plugin-autocomponent.ts");

if (finalContent !== original) {
  writeFileSync(target, finalContent, 'utf8');
}
