import type * as TanstackAIModule from "@tanstack/ai";
import type * as TanstackOpenAICompatibleModule from "@tanstack/ai-openai/compatible";

/** The `@tanstack/ai` module namespace. */
type TanstackAI = typeof TanstackAIModule;

/** The `@tanstack/ai-openai/compatible` module namespace. */
type TanstackOpenAICompatible = typeof TanstackOpenAICompatibleModule;

/** A dynamic `import()` with its module namespace typed. */
type DynamicImport = <T>(specifier: string) => Promise<T>;

/**
 * A dynamic `import()` that survives swc's CommonJS transform. swc rewrites a
 * literal or variable `import()` into `require()` when `module.type` is
 * `commonjs` (see `.swcrc`), and `require()` cannot resolve these packages:
 * `@tanstack/ai-openai` and `@tanstack/ai` 1.0.1 publish an `import`-only
 * exports map, so Node rejects them with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in
 * node_modules/@tanstack/ai-openai/package.json` (same for `@tanstack/ai`).
 * Assembling the function from a string keeps a real `import()` intact, so
 * Node resolves it as ESM.
 *
 * ponytail: the ceiling is the CommonJS server build; the upgrade path is an
 * ESM server build (or a package that adds a `require` condition), at which
 * point this seam becomes a static import.
 */
// oxlint-disable-next-line typescript/no-implied-eval -- required to preserve a real dynamic import through swc's CommonJS transform.
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);"
) as DynamicImport;

let tanstackPromise: Promise<TanstackAI> | undefined;
let openaiCompatiblePromise: Promise<TanstackOpenAICompatible> | undefined;

/**
 * Loads `@tanstack/ai` once and caches the promise. The package is ESM-only
 * with an `import`-only exports map, so it must be imported dynamically from
 * the CommonJS server build.
 *
 * @return the `@tanstack/ai` module namespace.
 */
export function loadTanstack(): Promise<TanstackAI> {
  tanstackPromise ??= dynamicImport<TanstackAI>("@tanstack/ai");
  return tanstackPromise;
}

/**
 * Loads `@tanstack/ai-openai/compatible` once and caches the promise. The
 * package is ESM-only with an `import`-only exports map, so it must be imported
 * dynamically from the CommonJS server build.
 *
 * @return the `@tanstack/ai-openai/compatible` module namespace.
 */
export function loadOpenaiCompatible(): Promise<TanstackOpenAICompatible> {
  openaiCompatiblePromise ??= dynamicImport<TanstackOpenAICompatible>(
    "@tanstack/ai-openai/compatible"
  );
  return openaiCompatiblePromise;
}
