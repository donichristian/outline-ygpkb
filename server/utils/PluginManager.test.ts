import path from "node:path";
import { glob } from "glob";
import { pluginEntryPointGlob } from "./PluginManager";

describe("pluginEntryPointGlob", () => {
  it("discovers plugin entry points from the build directory", () => {
    const matches = glob.sync(pluginEntryPointGlob("build"));

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
    expect(pluginEntryPointGlob("build")).toBe(
      "build/plugins/*/server/index.[jt]s"
    );
  });

  // glob reads "\" as an escape character rather than a path separator, so on
  // Windows the path.join form matches nothing while the posix form finds every
  // plugin. This is the regression: without posix separators no plugin registers.
  it.runIf(process.platform === "win32")(
    "finds plugins where a path.join built pattern finds none",
    () => {
      const legacy = glob.sync(
        path.join("build", "plugins/*/server/index.[jt]s")
      );

      expect(legacy).toEqual([]);
      expect(glob.sync(pluginEntryPointGlob("build")).length).toBeGreaterThan(0);
    }
  );
});