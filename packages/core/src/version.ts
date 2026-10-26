/**
 * Single source of truth for the version reported at runtime.
 *
 * The bundler (`scripts/build-cli.mjs`) replaces `__MOOKACODE_VERSION__` with the
 * version from `packages/cli/package.json`, so a release only needs one version
 * bump. When the code runs unbundled (tests, `tsx`) the fallback below is used.
 */
declare const __MOOKACODE_VERSION__: string | undefined;

export const MOOKACODE_VERSION: string = typeof __MOOKACODE_VERSION__ === 'string' ? __MOOKACODE_VERSION__ : '0.1.0';
