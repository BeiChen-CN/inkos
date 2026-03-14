import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(testDir, "..", "..");
const cliEntry = resolve(cliDir, "dist", "index.js");

let projectDir: string;

function run(args: string[], options?: { env?: Record<string, string> }): string {
  return execFileSync("node", [cliEntry, ...args], {
    cwd: projectDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Prevent global config from leaking into tests
      HOME: projectDir,
      ...options?.env,
    },
    timeout: 10_000,
  });
}

function runStderr(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [cliEntry, ...args], {
      cwd: projectDir,
      encoding: "utf-8",
      env: { ...process.env, HOME: projectDir },
      timeout: 10_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: unknown) {
    const err = e as { stdout: string; stderr: string; status: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.status ?? 1 };
  }
}

describe("CLI integration", () => {
  beforeAll(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "inkos-cli-test-"));
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("inkos --version", () => {
    it("prints version number", () => {
      const output = run(["--version"]);
      expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe("inkos --help", () => {
    it("prints help with command list", () => {
      const output = run(["--help"]);
      expect(output).toContain("inkos");
      expect(output).toContain("init");
      expect(output).toContain("book");
      expect(output).toContain("write");
    });
  });

  describe("inkos init", () => {
    it("initializes project in current directory", () => {
      const output = run(["init"]);
      expect(output).toContain("Project initialized");
    });

    it("creates inkos.json with correct structure", async () => {
      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.llm).toBeDefined();
      expect(config.llm.provider).toBe("openai");
      expect(config.llm.model).toBe("gpt-4o");
      expect(config.daemon).toBeDefined();
      expect(config.notify).toEqual([]);
    });

    it("creates .env file", async () => {
      const envContent = await readFile(join(projectDir, ".env"), "utf-8");
      expect(envContent).toContain("INKOS_LLM_API_KEY");
    });

    it("creates .gitignore", async () => {
      const gitignore = await readFile(join(projectDir, ".gitignore"), "utf-8");
      expect(gitignore).toContain(".env");
    });

    it("creates books/ and radar/ directories", async () => {
      const booksStat = await stat(join(projectDir, "books"));
      expect(booksStat.isDirectory()).toBe(true);
      const radarStat = await stat(join(projectDir, "radar"));
      expect(radarStat.isDirectory()).toBe(true);
    });
  });

  describe("inkos init <name>", () => {
    it("creates project in subdirectory", () => {
      const output = run(["init", "subproject"]);
      expect(output).toContain("Project initialized");
    });

    it("creates inkos.json in subdirectory", async () => {
      const raw = await readFile(join(projectDir, "subproject", "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.name).toBe("subproject");
    });
  });

  describe("inkos config set", () => {
    it("sets a top-level config value", () => {
      const output = run(["config", "set", "name", "test-project"]);
      expect(output).toContain("Set name = test-project");
    });

    it("sets a nested config value", async () => {
      run(["config", "set", "llm.model", "gpt-5"]);
      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.llm.model).toBe("gpt-5");
    });

    it("creates intermediate keys for deep paths", async () => {
      run(["config", "set", "custom.nested.key", "value"]);
      const raw = await readFile(join(projectDir, "inkos.json"), "utf-8");
      const config = JSON.parse(raw);
      expect(config.custom.nested.key).toBe("value");
    });
  });

  describe("inkos config show", () => {
    it("shows current config as JSON", () => {
      const output = run(["config", "show"]);
      const config = JSON.parse(output);
      expect(config.name).toBe("test-project");
      expect(config.llm.model).toBe("gpt-5");
    });
  });

  describe("inkos book list", () => {
    it("shows no books in empty project", () => {
      const output = run(["book", "list"]);
      expect(output).toContain("No books found");
    });

    it("returns empty array in JSON mode", () => {
      const output = run(["book", "list", "--json"]);
      const data = JSON.parse(output);
      expect(data.books).toEqual([]);
    });
  });

  describe("inkos status", () => {
    it("shows project status with zero books", () => {
      const output = run(["status"]);
      expect(output).toContain("Books: 0");
    });

    it("returns JSON with --json flag", () => {
      const output = run(["status", "--json"]);
      const data = JSON.parse(output);
      expect(data.project).toBeDefined();
      expect(data.books).toEqual([]);
    });

    it("errors for nonexistent book", () => {
      const { exitCode, stderr } = runStderr(["status", "nonexistent"]);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("inkos doctor", () => {
    it("checks environment health", () => {
      const { stdout } = runStderr(["doctor"]);
      expect(stdout).toContain("InkOS Doctor");
      expect(stdout).toContain("Node.js >= 20");
      expect(stdout).toContain("inkos.json");
    });
  });

  describe("inkos analytics", () => {
    it("errors when no book exists", () => {
      const { exitCode } = runStderr(["analytics"]);
      expect(exitCode).not.toBe(0);
    });
  });

  describe("inkos book file", () => {
    const bookId = "test-book";

    beforeAll(async () => {
      const bookDir = join(projectDir, "books", bookId);
      const storyDir = join(bookDir, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: bookId,
          title: "Test Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 100,
          chapterWordCount: 3000,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }, null, 2),
        "utf-8",
      );
      await writeFile(join(storyDir, "story_bible.md"), "# Original Bible", "utf-8");
      await writeFile(
        join(storyDir, "book_rules.md"),
        [
          "---",
          'version: "1.0"',
          "protagonist:",
          "  name: 林烬",
          "  personalityLock: [强势冷静]",
          "  behavioralConstraints: [不圣母]",
          "genreLock:",
          "  primary: xuanhuan",
          "  forbidden: [都市文风]",
          "prohibitions:",
          "  - 主角关键时刻心软",
          "chapterTypesOverride: []",
          "fatigueWordsOverride: []",
          "additionalAuditDimensions: []",
          "enableFullCastTracking: false",
          "---",
          "",
          "## 叙事视角",
          "第三人称近距离",
        ].join("\n"),
        "utf-8",
      );
    });

    it("lists editable story files", () => {
      const output = run(["book", "file", "list", "--json"]);
      const data = JSON.parse(output);
      expect(data.files).toContain("story_bible");
      expect(data.files).toContain("book_rules");
    });

    it("shows a story file", () => {
      const output = run(["book", "file", "show", bookId, "story_bible"]);
      expect(output).toContain("Original Bible");
    });

    it("updates a story file", async () => {
      const output = run([
        "book",
        "file",
        "set",
        bookId,
        "story_bible",
        "--content",
        "# Updated Bible",
      ]);
      expect(output).toContain(`Updated story_bible for ${bookId}.`);

      const content = await readFile(
        join(projectDir, "books", bookId, "story", "story_bible.md"),
        "utf-8",
      );
      expect(content).toBe("# Updated Bible");
    });
  });

  describe("inkos agent session utilities", () => {
    beforeAll(async () => {
      const sessionsDir = join(projectDir, ".inkos", "agent-sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "default.json"),
        JSON.stringify([
          { role: "user", content: "上一轮说了什么？" },
          { role: "assistant", content: "上一轮我们确认了主角设定。" },
        ], null, 2),
        "utf-8",
      );
    });

    it("shows saved agent history", () => {
      const output = run(["agent", "history"]);
      expect(output).toContain("Session: default");
      expect(output).toContain("上一轮我们确认了主角设定");
    });

    it("lists saved agent sessions", () => {
      const output = run(["agent", "sessions"]);
      expect(output).toContain("default");
      expect(output).toContain("messages: 2");
    });

    it("clears a saved agent session", () => {
      const output = run(["agent", "clear"]);
      expect(output).toContain('Cleared session "default".');
    });
  });
});
