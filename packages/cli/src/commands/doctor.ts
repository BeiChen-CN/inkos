import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot, log, logError } from "../utils.js";

export const doctorCommand = new Command("doctor")
  .description("Check environment and project health")
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const root = findProjectRoot();

    // 1. Check Node.js version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split(".")[0]!, 10);
    checks.push({
      name: "Node.js >= 20",
      ok: major >= 20,
      detail: nodeVersion,
    });

    // 2. Check inkos.json exists
    try {
      await readFile(join(root, "inkos.json"), "utf-8");
      checks.push({ name: "inkos.json", ok: true, detail: "Found" });
    } catch {
      checks.push({ name: "inkos.json", ok: false, detail: "Not found. Run 'inkos init'" });
    }

    // 3. Check .env exists
    try {
      await readFile(join(root, ".env"), "utf-8");
      checks.push({ name: ".env", ok: true, detail: "Found" });
    } catch {
      checks.push({ name: ".env", ok: false, detail: "Not found" });
    }

    // 4. Check LLM API key (from .env only)
    {
      const { config: loadDotenv } = await import("dotenv");
      loadDotenv({ path: join(root, ".env") });
      const apiKey = process.env.INKOS_LLM_API_KEY;
      const hasKey = !!apiKey && apiKey.length > 10 && apiKey !== "your-api-key-here";
      checks.push({
        name: "LLM API Key",
        ok: hasKey,
        detail: hasKey ? "Configured (from .env)" : "Missing in .env — set INKOS_LLM_API_KEY",
      });
    }

    // 5. Check books directory
    try {
      const { StateManager } = await import("@actalk/inkos-core");
      const state = new StateManager(root);
      const books = await state.listBooks();
      checks.push({
        name: "Books",
        ok: true,
        detail: `${books.length} book(s) found`,
      });
    } catch {
      checks.push({ name: "Books", ok: true, detail: "0 books" });
    }

    // 6. API connectivity test
    try {
      const { createLLMClient, chatCompletion } = await import("@actalk/inkos-core");
      const { loadConfig } = await import("../utils.js");
      const config = await loadConfig();
      const client = createLLMClient(config.llm);

      log("\n  [..] Testing API connectivity...");
      const response = await chatCompletion(client, config.llm.model, [
        { role: "user", content: "Say OK" },
      ], { maxTokens: 16 });

      checks.push({
        name: "API Connectivity",
        ok: true,
        detail: `OK (model: ${config.llm.model}, tokens: ${response.usage.totalTokens})`,
      });
    } catch (e) {
      checks.push({
        name: "API Connectivity",
        ok: false,
        detail: String(e).split("\n")[0]!,
      });
    }

    // Output
    log("\nInkOS Doctor\n");
    for (const check of checks) {
      const icon = check.ok ? "[OK]" : "[!!]";
      log(`  ${icon} ${check.name}: ${check.detail}`);
    }

    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      log(`\n${failed.length} issue(s) found.`);
    } else {
      log("\nAll checks passed.");
    }
  });
