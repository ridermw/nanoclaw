/**
 * NanoClaw Agent Runner (Copilot Edition)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses the official GitHub Copilot SDK (@github/copilot-sdk) for AI.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per turn).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  CopilotClient,
  CopilotSession,
  approveAll,
  type AssistantMessageEvent,
} from '@github/copilot-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single turn using the Copilot SDK session.
 * Sends the prompt, polls for IPC during execution, and emits output markers.
 */
async function runQuery(
  session: CopilotSession,
  prompt: string,
): Promise<{
  result: string | null;
  closedDuringQuery: boolean;
  bufferedMessages: string[];
}> {
  // Poll IPC for follow-up messages and _close sentinel during the query.
  // Messages arriving mid-turn are buffered and returned so the outer loop
  // can prepend them to the next prompt (Copilot SDK doesn't support
  // pushing messages mid-turn like Claude's MessageStream).
  let ipcPolling = true;
  let closedDuringQuery = false;
  const bufferedMessages: string[] = [];

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query');
      closedDuringQuery = true;
      session.abort().catch(() => {});
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`IPC follow-up message during query (${text.length} chars) — buffered for next turn`);
      bufferedMessages.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let resultText: string | null = null;

  try {
    // sendAndWait blocks until the session is idle (turn complete).
    // Timeout is generous — agent may run complex multi-step tasks.
    const response: AssistantMessageEvent | undefined = await session.sendAndWait(
      { prompt },
      10 * 60 * 1000, // 10 minute timeout per turn
    );

    if (response?.data?.content) {
      resultText = response.data.content;
      log(`Turn complete: ${resultText.slice(0, 200)}`);
    } else {
      log('Turn complete: no text content in response');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (closedDuringQuery) {
      log(`Turn aborted due to close sentinel: ${msg}`);
    } else {
      throw err;
    }
  } finally {
    ipcPolling = false;
  }

  return { result: resultText, closedDuringQuery, bufferedMessages };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const model = process.env.COPILOT_MODEL || 'gpt-4.1';

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Load memory files as additional system context.
  // Global CLAUDE.md is shared across all non-main groups.
  // Per-group CLAUDE.md provides group-specific persona/memory.
  // Both are loaded and concatenated into the system message.
  const systemParts: string[] = [];
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  const groupClaudeMdPath = '/workspace/group/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }
  if (fs.existsSync(groupClaudeMdPath)) {
    systemParts.push(fs.readFileSync(groupClaudeMdPath, 'utf-8'));
  }
  const systemContent = systemParts.length > 0 ? systemParts.join('\n\n---\n\n') : undefined;

  // Initialize Copilot SDK client and session
  log(`Initializing Copilot SDK (model: ${model})...`);
  const client = new CopilotClient({
    cwd: '/workspace/group',
    logLevel: 'warning',
    // The Copilot CLI is installed globally in the container (npm install -g @github/copilot).
    // We must tell the SDK where to find it since it's not a local dependency.
    cliPath: 'copilot',
  });

  let session: CopilotSession;
  const sessionConfig = {
    model,
    clientName: 'nanoclaw',
    onPermissionRequest: approveAll,
    workingDirectory: '/workspace/group',
    systemMessage: systemContent
      ? { mode: 'append' as const, content: systemContent }
      : undefined,
    mcpServers: {
      nanoclaw: {
        type: 'local' as const,
        command: 'node',
        args: [mcpServerPath],
        tools: ['*' as string],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
    skillDirectories: ['/home/node/.copilot/skills', '/workspace/project/container/skills'],
  };

  try {
    if (containerInput.sessionId) {
      log(`Resuming session: ${containerInput.sessionId}`);
      session = await client.resumeSession(containerInput.sessionId, sessionConfig);
    } else {
      session = await client.createSession(sessionConfig);
    }
    log(`Session ready: ${session.sessionId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to create Copilot session: ${msg}`);
    writeOutput({
      status: 'error',
      result: null,
      error: `Copilot session failed: ${msg}`,
    });
    await client.stop().catch(() => {});
    process.exit(1);
  }

  // Query loop: send prompt → wait for IPC message → send again → repeat
  try {
    while (true) {
      log(`Starting turn (session: ${session.sessionId})...`);

      const queryResult = await runQuery(session, prompt);

      if (queryResult.result !== null) {
        writeOutput({
          status: 'success',
          result: queryResult.result,
          newSessionId: session.sessionId,
        });
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: session.sessionId,
      });

      // If messages arrived mid-turn, use them immediately instead of waiting
      if (queryResult.bufferedMessages.length > 0) {
        log(`Using ${queryResult.bufferedMessages.length} buffered mid-turn message(s)`);
        prompt = queryResult.bufferedMessages.join('\n');
        continue;
      }

      log('Turn ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new turn`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session.sessionId,
      error: errorMessage,
    });
  } finally {
    await session.disconnect().catch(() => {});
    await client.stop().catch(() => {});
  }
}

main();
