// Portable replacement for `mkdir -p ./build/shared/i18n && cp -R ./shared/i18n/locales ./build/shared/i18n`.
// The POSIX originals fail on cmd.exe, which made `yarn build:i18n` abort after
// extraction had already rewritten the catalog. Runs identically on Windows and POSIX.
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const source = resolve("shared/i18n/locales");
const destination = resolve("build/shared/i18n/locales");

// mkdirSync(..., { recursive: true }) is the `mkdir -p` equivalent: nested parents
// are created and an existing directory is not an error.
mkdirSync(destination, { recursive: true });

// Copy entry by entry instead of `cpSync(source, destination)`. Copying per entry
// matches POSIX `cp -R source parent`, which merges into an existing destination
// rather than nesting a second `locales` directory inside it.
for (const entry of readdirSync(source, { withFileTypes: true })) {
  cpSync(join(source, entry.name), join(destination, entry.name), {
    recursive: true,
    force: true,
  });
}

// Verify the copy rather than assume it. This is the hazard the POSIX version never
// guarded against: a byte-level copy is safe, but any text-mode normalisation would
// silently rewrite line endings and corrupt the catalogs in ./build.
function walk(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

const copied = walk(destination).sort();
const original = walk(source).sort();

if (copied.length !== original.length || copied.some((f, i) => f !== original[i])) {
  throw new Error(
    `copy:i18n tree mismatch — expected ${original.length} files, found ${copied.length}`
  );
}

for (const file of original) {
  if (!readFileSync(join(source, file)).equals(readFileSync(join(destination, file)))) {
    throw new Error(`copy:i18n file is not byte-identical to its source: ${file}`);
  }
}

console.log(`copy:i18n — ${copied.length} locale files copied and verified`);