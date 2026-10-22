import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { pluginEntryPointGlob } from "./PluginManager";

// A relative fixture root keeps the glob posix — an absolute Windows root would
// reintroduce the backslash bug these tests exist to catch.
const fixtureRoot = `plugin-glob-fixture-${randomUUID()}`;

describe("pluginEntryPointGlob", () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(fixtureRoot, "plugins/search-postgres/server"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fixtureRoot, "plugins/search-postgres/server/index.js"),
      ""
    );
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("discovers plugin entry points under a given root directory", () => {
    const matches = glob.sync(pluginEntryPointGlob(fixtureRoot));

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.includes("search-postgres"))).toBe(
      true
    );
  });

  it("discovers plugin entry points from the source tree", () => {
    const matches = glob.sync(pluginEntryPointGlob(""));

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.includes("search-postgres"))).toBe(
      true
    );
  });

  // An empty root must stay relative — prefixing with a separator makes it
  // absolute from the filesystem root, where it matches nothing.
  it("keeps the pattern relative when no root directory is given", () => {
    expect(pluginEntryPointGlob("")).toBe("plugins/*/server/index.[jt]s");
    expect(pluginEntryPointGlob("root")).toBe(
      "root/plugins/*/server/index.[jt]s"
    );
  });

  // glob reads "\" as an escape character rather than a path separator, so on
  // Windows the path.join form matches nothing while the posix form finds every
  // plugin. This is the regression: without posix separators no plugin registers.
  it.runIf(process.platform === "win32")(
    "finds plugins where a path.join built pattern finds none",
    () => {
      const legacy = glob.sync(
        path.join(fixtureRoot, "plugins/*/server/index.[jt]s")
      );

      expect(legacy).toEqual([]);
      expect(
        glob.sync(pluginEntryPointGlob(fixtureRoot)).length
      ).toBeGreaterThan(0);
    }
  );
});
