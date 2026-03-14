import { Command } from "commander";
import { runAgentLoop, StateManager, type ToolCall } from "@actalk/inkos-core";
import { loadConfig, createClient, findProjectRoot, resolveContext, log, logError } from "../utils.js";

export const agentCommand = new Command("agent")
  .description("Natural language agent mode (LLM orchestrates via tool-use)")
  .argument("<instruction>", "Natural language instruction")
  .option("--context <text>", "Additional context (natural language)")
  .option("--context-file <path>", "Read additional context from file")
  .option("--max-turns <n>", "Maximum agent turns", "20")
  .option("--session <id>", "Conversation session ID", "default")
  .option("--no-memory", "Disable loading/saving conversation history")
  .option("--json", "Output JSON (suppress progress messages)")
  .option("--quiet", "Suppress tool call logs")
  .action(async (instruction: string, opts) => {
    try {
      const config = await loadConfig();
      const client = createClient(config);
      const root = findProjectRoot();
      const state = new StateManager(root);
      const context = await resolveContext(opts);
      const sessionId = opts.session as string;
      const useMemory = opts.memory as boolean;
      const history = useMemory
        ? await state.loadAgentSession(sessionId)
        : [];

      const fullInstruction = context
        ? `${instruction}\n\n补充信息：${context}`
        : instruction;

      const maxTurns = parseInt(opts.maxTurns, 10);

      if (!opts.json && useMemory) {
        log(`[session] ${sessionId} | resumed messages: ${history.length}`);
      }

      const result = await runAgentLoop(
        {
          client,
          model: config.llm.model,
          projectRoot: root,
        },
        fullInstruction,
        {
          maxTurns,
          sessionId,
          useMemory,
          onToolCall: opts.quiet || opts.json
            ? undefined
            : (name: string, args: Record<string, unknown>) => {
                log(`  [tool] ${name}(${JSON.stringify(args)})`);
              },
          onToolResult: opts.quiet || opts.json
            ? undefined
            : (name: string, result: string) => {
                const preview = result.length > 200 ? `${result.slice(0, 200)}...` : result;
                log(`  [result] ${name} → ${preview}`);
              },
          onMessage: opts.json
            ? undefined
            : (content: string) => {
                log(`\n${content}`);
              },
        },
      );

      if (opts.json) {
        log(JSON.stringify({
          result,
          sessionId: useMemory ? sessionId : null,
          resumedMessages: history.length,
        }));
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Agent failed: ${e}`);
      }
      process.exit(1);
    }
  });

agentCommand
  .command("history")
  .description("Show saved conversation history")
  .argument("[session-id]", "Session ID", "default")
  .option("--json", "Output JSON")
  .action(async (sessionId: string, opts) => {
    try {
      const state = new StateManager(findProjectRoot());
      const messages = await state.loadAgentSession(sessionId);

      if (opts.json) {
        log(JSON.stringify({ sessionId, messages }, null, 2));
        return;
      }

      if (messages.length === 0) {
        log(`No saved history for session \"${sessionId}\".`);
        return;
      }

      log(`Session: ${sessionId}`);
      for (const message of messages) {
        if (message.role === "user") {
          log(`\n[user]\n${message.content}`);
          continue;
        }
        if (message.role === "assistant") {
          log(`\n[assistant]\n${message.content ?? ""}`);
          if (message.toolCalls?.length) {
            log(`[tool-calls] ${message.toolCalls.map((tool: ToolCall) => tool.name).join(", ")}`);
          }
          continue;
        }
        if (message.role === "tool") {
          log(`\n[tool:${message.toolCallId}]\n${message.content}`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to read agent history: ${e}`);
      }
      process.exit(1);
    }
  });

agentCommand
  .command("sessions")
  .description("List saved conversation sessions")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const state = new StateManager(findProjectRoot());
      const sessions = await state.listAgentSessions();

      if (opts.json) {
        log(JSON.stringify({ sessions }, null, 2));
        return;
      }

      if (sessions.length === 0) {
        log("No saved agent sessions.");
        return;
      }

      for (const session of sessions) {
        log(`${session.id} | messages: ${session.messageCount} | updated: ${session.updatedAt}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to list agent sessions: ${e}`);
      }
      process.exit(1);
    }
  });

agentCommand
  .command("clear")
  .description("Delete saved conversation history for a session")
  .argument("[session-id]", "Session ID", "default")
  .action(async (sessionId: string) => {
    try {
      const state = new StateManager(findProjectRoot());
      await state.deleteAgentSession(sessionId);
      log(`Cleared session \"${sessionId}\".`);
    } catch (e) {
      logError(`Failed to clear agent session: ${e}`);
      process.exit(1);
    }
  });
