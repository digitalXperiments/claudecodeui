import { PrismLight } from 'react-syntax-highlighter';

// Register grammars straight from refractor — the exact modules
// react-syntax-highlighter's dist/esm/languages/prism/* wrappers re-export, so
// highlighting output is identical to the esm wrappers. Unlike those wrappers
// (ESM files inside a CJS package, which Node's loader cannot import), the
// refractor files are plain `module.exports = fn` CJS, so this module works
// both in the Vite bundle and under `tsx --test`.
import bash from 'refractor/lang/bash.js';
import batch from 'refractor/lang/batch.js';
import c from 'refractor/lang/c.js';
import clike from 'refractor/lang/clike.js';
import cpp from 'refractor/lang/cpp.js';
import csharp from 'refractor/lang/csharp.js';
import css from 'refractor/lang/css.js';
import dart from 'refractor/lang/dart.js';
import diff from 'refractor/lang/diff.js';
import docker from 'refractor/lang/docker.js';
import elixir from 'refractor/lang/elixir.js';
import go from 'refractor/lang/go.js';
import graphql from 'refractor/lang/graphql.js';
import groovy from 'refractor/lang/groovy.js';
import haskell from 'refractor/lang/haskell.js';
import hcl from 'refractor/lang/hcl.js';
import ini from 'refractor/lang/ini.js';
import java from 'refractor/lang/java.js';
import javascript from 'refractor/lang/javascript.js';
import json from 'refractor/lang/json.js';
import json5 from 'refractor/lang/json5.js';
import jsx from 'refractor/lang/jsx.js';
import kotlin from 'refractor/lang/kotlin.js';
import less from 'refractor/lang/less.js';
import lua from 'refractor/lang/lua.js';
import makefile from 'refractor/lang/makefile.js';
import markdown from 'refractor/lang/markdown.js';
import markup from 'refractor/lang/markup.js';
import nginx from 'refractor/lang/nginx.js';
import objectivec from 'refractor/lang/objectivec.js';
import perl from 'refractor/lang/perl.js';
import php from 'refractor/lang/php.js';
import powershell from 'refractor/lang/powershell.js';
import properties from 'refractor/lang/properties.js';
import protobuf from 'refractor/lang/protobuf.js';
import python from 'refractor/lang/python.js';
import r from 'refractor/lang/r.js';
import regex from 'refractor/lang/regex.js';
import ruby from 'refractor/lang/ruby.js';
import rust from 'refractor/lang/rust.js';
import scala from 'refractor/lang/scala.js';
import scss from 'refractor/lang/scss.js';
import solidity from 'refractor/lang/solidity.js';
import sql from 'refractor/lang/sql.js';
import swift from 'refractor/lang/swift.js';
import toml from 'refractor/lang/toml.js';
import tsx from 'refractor/lang/tsx.js';
import typescript from 'refractor/lang/typescript.js';
import vim from 'refractor/lang/vim.js';
import yaml from 'refractor/lang/yaml.js';
import zig from 'refractor/lang/zig.js';

// The two themes the app renders with. The per-theme CJS files carry the same
// generated objects as the dist/esm styles barrel these components previously
// imported; deep per-theme paths also keep the other ~40 themes out of the
// bundle. `unwrapDefault` bridges the interop difference between Vite (gives
// the transpiled default directly) and Node (gives the whole module.exports).
import oneDarkModule from 'react-syntax-highlighter/dist/cjs/styles/prism/one-dark';
import oneLightModule from 'react-syntax-highlighter/dist/cjs/styles/prism/one-light';

/**
 * The syntax highlighter every code block in the app renders through — chat
 * markdown (Markdown.tsx), the code editor's markdown preview
 * (MarkdownCodeBlock.tsx) and mission-control article drafts
 * (ArticleDraftCard.tsx).
 *
 * `react-syntax-highlighter`'s default `Prism` export bundles every language
 * Prism ships — around 290 of them. That is a large slice of the client
 * bundle, and registering them costs a depth-first walk of the whole grammar
 * table on startup, before the app can paint.
 *
 * These are the languages a coding agent actually emits fences for. Anything
 * outside the list still renders — refractor falls back to plain text for an
 * unknown grammar — it simply is not coloured. Each grammar registers its own
 * aliases, so `sh`, `yml`, `py` and friends resolve without being listed
 * separately.
 */
const LANGUAGES = {
  bash, batch, c, clike, cpp, csharp, css, dart, diff, docker, elixir, go,
  graphql, groovy, haskell, hcl, ini, java, javascript, json, json5, jsx,
  kotlin, less, lua, makefile, markdown, markup, nginx, objectivec, perl, php,
  powershell, properties, protobuf, python, r, regex, ruby, rust, scala, scss,
  solidity, sql, swift, toml, tsx, typescript, vim, yaml, zig,
};

for (const [name, language] of Object.entries(LANGUAGES)) {
  PrismLight.registerLanguage(name, language);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const unwrapDefault = (mod: any) => (mod && mod.default ? mod.default : mod);

export const oneDark = unwrapDefault(oneDarkModule);
export const oneLight = unwrapDefault(oneLightModule);

export const SyntaxHighlighter = PrismLight;
