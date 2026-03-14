import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { AgentMessage } from "../llm/provider.js";
import { parseBookRules } from "../models/book-rules.js";

export const EDITABLE_STORY_FILES = {
  story_bible: "story_bible.md",
  volume_outline: "volume_outline.md",
  book_rules: "book_rules.md",
  current_state: "current_state.md",
  pending_hooks: "pending_hooks.md",
  particle_ledger: "particle_ledger.md",
  subplot_board: "subplot_board.md",
  emotional_arcs: "emotional_arcs.md",
  character_matrix: "character_matrix.md",
  style_guide: "style_guide.md",
  parent_canon: "parent_canon.md",
} as const;

export type EditableStoryFileKey = keyof typeof EDITABLE_STORY_FILES;

export interface AgentSessionInfo {
  readonly id: string;
  readonly messageCount: number;
  readonly updatedAt: string;
}

export class StateManager {
  constructor(private readonly projectRoot: string) {}

  private assertStoryFileKey(fileKey: string): asserts fileKey is EditableStoryFileKey {
    if (!(fileKey in EDITABLE_STORY_FILES)) {
      throw new Error(
        `Unsupported story file key: ${fileKey}. Supported keys: ${Object.keys(EDITABLE_STORY_FILES).join(", ")}`,
      );
    }
  }

  private get agentSessionsDir(): string {
    return join(this.projectRoot, ".inkos", "agent-sessions");
  }

  private sessionPath(sessionId: string): string {
    return join(this.agentSessionsDir, `${encodeURIComponent(sessionId)}.json`);
  }

  private resolveStoryFile(bookId: string, fileKey: EditableStoryFileKey): string {
    return join(this.bookDir(bookId), "story", EDITABLE_STORY_FILES[fileKey]);
  }

  private validateStoryFileContent(fileKey: EditableStoryFileKey, content: string): void {
    if (!content.trim()) {
      throw new Error(`Story file "${fileKey}" cannot be empty`);
    }
    if (fileKey === "book_rules") {
      if (!/---\s*\n[\s\S]*?\n---/.test(content)) {
        throw new Error("book_rules must include YAML frontmatter wrapped in --- markers");
      }
      parseBookRules(content);
    }
  }

  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    const lockPath = join(this.bookDir(bookId), ".write.lock");
    try {
      await stat(lockPath);
      const lockData = await readFile(lockPath, "utf-8");
      throw new Error(
        `Book "${bookId}" is locked by another process (${lockData}). ` +
          `If this is stale, delete ${lockPath}`,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("is locked")) throw e;
    }
    await writeFile(lockPath, `pid:${process.pid} ts:${Date.now()}`, "utf-8");
    return async () => {
      try {
        await unlink(lockPath);
      } catch {
        // ignore
      }
    };
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    const dir = this.bookDir(bookId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const index = await this.loadChapterIndex(bookId);
    if (index.length === 0) return 1;
    const maxNum = Math.max(...index.map((ch) => ch.number));
    return maxNum + 1;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify(index, null, 2),
      "utf-8",
    );
  }

  async readStoryFile(bookId: string, fileKey: EditableStoryFileKey): Promise<string> {
    this.assertStoryFileKey(fileKey);
    const path = this.resolveStoryFile(bookId, fileKey);
    return readFile(path, "utf-8");
  }

  async writeStoryFile(
    bookId: string,
    fileKey: EditableStoryFileKey,
    content: string,
  ): Promise<void> {
    this.assertStoryFileKey(fileKey);
    this.validateStoryFileContent(fileKey, content);
    const storyDir = join(this.bookDir(bookId), "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(this.resolveStoryFile(bookId, fileKey), content, "utf-8");
  }

  listEditableStoryFiles(): ReadonlyArray<EditableStoryFileKey> {
    return Object.keys(EDITABLE_STORY_FILES) as EditableStoryFileKey[];
  }

  async loadAgentSession(sessionId: string): Promise<ReadonlyArray<AgentMessage>> {
    try {
      const raw = await readFile(this.sessionPath(sessionId), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Agent session "${sessionId}" is invalid`);
      }
      return parsed as ReadonlyArray<AgentMessage>;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async saveAgentSession(
    sessionId: string,
    messages: ReadonlyArray<AgentMessage>,
  ): Promise<void> {
    await mkdir(this.agentSessionsDir, { recursive: true });
    await writeFile(
      this.sessionPath(sessionId),
      JSON.stringify(messages, null, 2),
      "utf-8",
    );
  }

  async deleteAgentSession(sessionId: string): Promise<void> {
    try {
      await unlink(this.sessionPath(sessionId));
    } catch {
      // ignore missing session file
    }
  }

  async listAgentSessions(): Promise<ReadonlyArray<AgentSessionInfo>> {
    try {
      const entries = await readdir(this.agentSessionsDir);
      const sessions = await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map(async (entry) => {
            const id = decodeURIComponent(entry.replace(/\.json$/, ""));
            const path = join(this.agentSessionsDir, entry);
            const [raw, fileStat] = await Promise.all([
              readFile(path, "utf-8"),
              stat(path),
            ]);
            const parsed = JSON.parse(raw) as unknown;
            const messageCount = Array.isArray(parsed) ? parsed.length : 0;
            return {
              id,
              messageCount,
              updatedAt: fileStat.mtime.toISOString(),
            } satisfies AgentSessionInfo;
          }),
      );
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // The first 3 files are required; the rest are optional (may not exist in older snapshots)
      const requiredFiles = files.slice(0, 3);
      const optionalFiles = files.slice(3);

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(join(storyDir, f), content, "utf-8");
          } catch {
            // Optional file missing in older snapshots — skip
          }
        }),
      );

      return true;
    } catch {
      return false;
    }
  }
}
