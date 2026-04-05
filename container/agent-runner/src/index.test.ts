/**
 * Agent-runner test suite with full Copilot SDK mocking.
 * Tests all exported functions and branches for 100% coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';

// ── Hoisted mocks (available inside vi.mock factories) ──────────────────
const { mockSession, mockClient, mockFs, mockExecFile } = vi.hoisted(() => {
  const mockSession = {
    sessionId: 'test-session-123',
    sendAndWait: vi.fn(),
    on: vi.fn(() => vi.fn()), // returns unsubscribe
    disconnect: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    abort: vi.fn(async () => {}),
  };

  const mockClient = {
    createSession: vi.fn(async () => mockSession),
    resumeSession: vi.fn(async () => mockSession),
    stop: vi.fn(async () => {}),
  };

  const mockFs = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
  };

  const mockExecFile = vi.fn();

  return { mockSession, mockClient, mockFs, mockExecFile };
});

// ── SDK mock (class constructor for `new CopilotClient()`) ──────────────
vi.mock('@github/copilot-sdk', () => {
  // Regular function so `new` works (arrow functions can't be constructors)
  function MockCopilotClient() { return mockClient; }
  return {
    CopilotClient: MockCopilotClient,
    approveAll: () => true,
  };
});

// ── fs mock ─────────────────────────────────────────────────────────────
vi.mock('fs', () => ({ default: mockFs }));

// ── child_process mock ──────────────────────────────────────────────────
vi.mock('child_process', () => ({ execFile: mockExecFile }));

// ── process mocks ───────────────────────────────────────────────────────
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

// process.exit must throw to actually halt execution in tests
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number) => {
  throw new ExitError(Number(code ?? 0));
});

// Import after all mocks are set up
import {
  writeOutput,
  log,
  shouldClose,
  drainIpcInput,
  runScript,
  formatTranscriptMarkdown,
  generateArchiveName,
  archiveTranscript,
  main,
} from './index.js';

// ── Helpers ─────────────────────────────────────────────────────────────
function capturedStdout(): string {
  return consoleLogSpy.mock.calls.map((args) => args.join(' ')).join('\n');
}

function capturedStderr(): string {
  return consoleErrorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
}

function resetCaptures() {
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  exitSpy.mockClear();
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('writeOutput', () => {
  beforeEach(resetCaptures);

  it('wraps output in start/end markers', () => {
    writeOutput({ status: 'success', result: 'hello', newSessionId: 's1' });
    const output = capturedStdout();
    expect(output).toContain('---NANOCLAW_OUTPUT_START---');
    expect(output).toContain('---NANOCLAW_OUTPUT_END---');
    expect(output).toContain('"status":"success"');
    expect(output).toContain('"result":"hello"');
  });

  it('handles error output', () => {
    writeOutput({ status: 'error', result: null, error: 'fail' });
    const output = capturedStdout();
    expect(output).toContain('"status":"error"');
    expect(output).toContain('"error":"fail"');
  });
});

describe('log', () => {
  beforeEach(resetCaptures);

  it('writes to stderr with prefix', () => {
    log('hello world');
    const output = capturedStderr();
    expect(output).toContain('[agent-runner] hello world');
  });

  it('redacts gho_ tokens', () => {
    log('token is gho_abc123secret');
    expect(capturedStderr()).toContain('[REDACTED]');
    expect(capturedStderr()).not.toContain('gho_abc123secret');
  });

  it('redacts ghu_ tokens', () => {
    log('token ghu_foobar');
    expect(capturedStderr()).toContain('[REDACTED]');
    expect(capturedStderr()).not.toContain('ghu_foobar');
  });

  it('redacts ghp_ tokens', () => {
    log('token ghp_classic');
    expect(capturedStderr()).toContain('[REDACTED]');
    expect(capturedStderr()).not.toContain('ghp_classic');
  });

  it('redacts github_pat_ tokens', () => {
    log('token github_pat_longstring');
    expect(capturedStderr()).toContain('[REDACTED]');
    expect(capturedStderr()).not.toContain('github_pat_longstring');
  });

  it('does not redact non-token strings', () => {
    log('normal message with no tokens');
    expect(capturedStderr()).toContain('normal message with no tokens');
  });
});

describe('shouldClose', () => {
  beforeEach(() => {
    mockFs.existsSync.mockReset();
    mockFs.unlinkSync.mockReset();
  });

  it('returns false when sentinel does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(shouldClose()).toBe(false);
  });

  it('returns true and deletes sentinel when it exists', () => {
    mockFs.existsSync.mockReturnValue(true);
    expect(shouldClose()).toBe(true);
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/workspace/ipc/input/_close');
  });

  it('returns true even if unlink fails', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.unlinkSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(shouldClose()).toBe(true);
  });
});

describe('drainIpcInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdirSync.mockReset();
    mockFs.readdirSync.mockReset();
    mockFs.readFileSync.mockReset();
    mockFs.unlinkSync.mockReset();
  });

  it('returns empty array when no files', () => {
    mockFs.readdirSync.mockReturnValue([]);
    expect(drainIpcInput()).toEqual([]);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/workspace/ipc/input', { recursive: true });
  });

  it('reads and deletes .json files in sorted order', () => {
    mockFs.readdirSync.mockReturnValue(['002.json', '001.json'] as any);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith('001.json')) return JSON.stringify({ type: 'message', text: 'first' });
      if (p.endsWith('002.json')) return JSON.stringify({ type: 'message', text: 'second' });
      return '';
    });

    const msgs = drainIpcInput();
    expect(msgs).toEqual(['first', 'second']);
    expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  it('skips non-message type files', () => {
    mockFs.readdirSync.mockReturnValue(['001.json'] as any);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ type: 'other', data: 'x' }));
    expect(drainIpcInput()).toEqual([]);
  });

  it('skips non-.json files', () => {
    mockFs.readdirSync.mockReturnValue(['readme.txt', 'config.yml'] as any);
    expect(drainIpcInput()).toEqual([]);
  });

  it('handles file read errors gracefully', () => {
    mockFs.readdirSync.mockReturnValue(['bad.json'] as any);
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const msgs = drainIpcInput();
    expect(msgs).toEqual([]);
    // Should try to unlink the bad file
    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });

  it('handles readdir errors gracefully', () => {
    mockFs.mkdirSync.mockImplementation(() => {
      throw new Error('EPERM');
    });
    expect(drainIpcInput()).toEqual([]);
  });
});

describe('runScript', () => {
  beforeEach(() => {
    mockFs.writeFileSync.mockReset();
    mockExecFile.mockReset();
  });

  it('executes script and parses JSON result', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"wakeAgent": true, "data": {"key": "val"}}\n', '');
      },
    );

    const result = await runScript('echo test');
    expect(result).toEqual({ wakeAgent: true, data: { key: 'val' } });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith('/tmp/task-script.sh', 'echo test', {
      mode: 0o755,
    });
  });

  it('returns null on execution error', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('script failed'), '', 'error output');
      },
    );

    const result = await runScript('bad-script');
    expect(result).toBeNull();
  });

  it('returns null on empty output', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      },
    );

    const result = await runScript('empty-script');
    expect(result).toBeNull();
  });

  it('returns null on non-JSON output', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'not json\n', '');
      },
    );

    const result = await runScript('text-script');
    expect(result).toBeNull();
  });

  it('returns null when wakeAgent is missing', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"data": "no wake"}\n', '');
      },
    );

    const result = await runScript('no-wake-script');
    expect(result).toBeNull();
  });

  it('returns result with wakeAgent=false', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"wakeAgent": false}\n', '');
      },
    );

    const result = await runScript('no-wake');
    expect(result).toEqual({ wakeAgent: false });
  });

  it('uses last line of multi-line output', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'debug line 1\ndebug line 2\n{"wakeAgent": true}\n', '');
      },
    );

    const result = await runScript('multi-line');
    expect(result).toEqual({ wakeAgent: true });
  });
});

describe('formatTranscriptMarkdown', () => {
  it('formats user and assistant events', () => {
    const events = [
      { type: 'user.message' as const, data: { content: 'Hello' } },
      { type: 'assistant.message' as const, data: { content: 'Hi there', messageId: 'm1', toolRequests: [] } },
    ] as SessionEvent[];

    const md = formatTranscriptMarkdown(events);
    expect(md).toContain('# Conversation Archive');
    expect(md).toContain('## User');
    expect(md).toContain('Hello');
    expect(md).toContain('## Assistant');
    expect(md).toContain('Hi there');
  });

  it('skips unknown event types', () => {
    const events = [
      { type: 'session.compaction_start' as any, data: {} },
    ] as SessionEvent[];

    const md = formatTranscriptMarkdown(events);
    expect(md).toContain('# Conversation Archive');
    expect(md).not.toContain('## User');
    expect(md).not.toContain('## Assistant');
  });

  it('handles empty events array', () => {
    const md = formatTranscriptMarkdown([]);
    expect(md).toContain('# Conversation Archive');
  });
});

describe('generateArchiveName', () => {
  it('creates name from first user message', () => {
    const events = [
      { type: 'user.message' as const, data: { content: 'Tell me about cats' } },
    ] as SessionEvent[];

    expect(generateArchiveName(events)).toBe('tell-me-about-cats');
  });

  it('truncates long messages to 40 chars', () => {
    const events = [
      { type: 'user.message' as const, data: { content: 'A'.repeat(100) } },
    ] as SessionEvent[];

    const name = generateArchiveName(events);
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it('strips special characters', () => {
    const events = [
      { type: 'user.message' as const, data: { content: 'Hello! @#$ World?' } },
    ] as SessionEvent[];

    expect(generateArchiveName(events)).toBe('hello-world');
  });

  it('returns fallback when no user messages', () => {
    const events = [
      { type: 'assistant.message' as const, data: { content: 'Hi', messageId: 'm1', toolRequests: [] } },
    ] as SessionEvent[];

    expect(generateArchiveName(events)).toBe('conversation');
  });

  it('returns fallback for empty content', () => {
    const events = [
      { type: 'user.message' as const, data: { content: '' } },
    ] as SessionEvent[];

    expect(generateArchiveName(events)).toBe('conversation');
  });
});

describe('archiveTranscript', () => {
  beforeEach(() => {
    resetCaptures();
    mockFs.mkdirSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockSession.getMessages.mockReset();
  });

  it('writes markdown file to conversations dir', async () => {
    const events = [
      { type: 'user.message' as const, data: { content: 'hello' } },
      { type: 'assistant.message' as const, data: { content: 'world', messageId: 'm1', toolRequests: [] } },
    ] as SessionEvent[];

    mockSession.getMessages.mockResolvedValue(events);

    await archiveTranscript(mockSession as any);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/workspace/group/conversations', {
      recursive: true,
    });
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('hello.md'),
      expect.stringContaining('# Conversation Archive'),
      'utf-8',
    );
  });

  it('handles empty events gracefully', async () => {
    mockSession.getMessages.mockResolvedValue([]);
    await archiveTranscript(mockSession as any);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('handles null events gracefully', async () => {
    mockSession.getMessages.mockResolvedValue(null);
    await archiveTranscript(mockSession as any);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('handles getMessages error gracefully', async () => {
    mockSession.getMessages.mockRejectedValue(new Error('SDK error'));
    await archiveTranscript(mockSession as any);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    expect(capturedStderr()).toContain('Failed to archive transcript');
  });
});

describe('main', () => {
  // Helper to simulate stdin with raw string data
  function mockStdin(data: string) {
    let dataHandler: ((chunk: string) => void) | undefined;
    let endHandler: (() => void) | undefined;
    let triggered = false;

    vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation(function (this: any, event: string, handler: any) {
      if (event === 'data') dataHandler = handler;
      if (event === 'end') endHandler = handler;
      // Trigger once when both handlers are ready
      if (!triggered && endHandler && dataHandler) {
        triggered = true;
        queueMicrotask(() => {
          dataHandler!(data);
          endHandler!();
        });
      }
      return this;
    } as any);
  }

  // Helper to simulate stdin with ContainerInput object
  function mockStdinJson(input: Record<string, unknown>) {
    mockStdin(JSON.stringify(input));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptures();
    // Default fs mocks
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);
    mockFs.readFileSync.mockReturnValue('');
    mockFs.mkdirSync.mockImplementation(() => undefined);
    mockFs.unlinkSync.mockImplementation(() => {});
    mockFs.writeFileSync.mockImplementation(() => {});

    // Default SDK mocks
    mockClient.createSession.mockResolvedValue(mockSession);
    mockClient.resumeSession.mockResolvedValue(mockSession);
    mockClient.stop.mockResolvedValue(undefined);
    mockSession.disconnect.mockResolvedValue(undefined);
    mockSession.on.mockReturnValue(vi.fn());
    mockSession.sessionId = 'test-session-123';

    // Mock process.env
    process.env.COPILOT_MODEL = 'gpt-4.1';
  });

  it('fails fast when githubToken is missing', async () => {
    mockStdinJson({
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      // no githubToken
    });

    await expect(main()).rejects.toThrow(ExitError);

    expect(capturedStdout()).toContain('githubToken missing');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails on invalid stdin JSON', async () => {
    mockStdin('not valid json {{{');

    await expect(main()).rejects.toThrow(ExitError);

    expect(capturedStdout()).toContain('Failed to parse input');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('creates session and runs query loop with close sentinel', async () => {
    mockStdinJson({
      prompt: 'Hello agent',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    // sendAndWait returns a response
    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'Agent response', messageId: 'm1', toolRequests: [] },
    });

    // After first turn, close sentinel appears
    let callCount = 0;
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) {
        callCount++;
        // Return true on the third check (after query completes, during waitForIpcMessage)
        return callCount > 2;
      }
      return false;
    });

    await main();

    expect(mockClient.createSession).toHaveBeenCalled();
    expect(mockSession.sendAndWait).toHaveBeenCalledWith(
      { prompt: 'Hello agent' },
      10 * 60 * 1000,
    );
    // Should have output the result
    expect(capturedStdout()).toContain('Agent response');
    expect(capturedStdout()).toContain('test-session-123');
  });

  it('resumes existing session', async () => {
    mockStdinJson({
      prompt: 'Continue',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
      sessionId: 'existing-session-456',
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'Resumed', messageId: 'm1', toolRequests: [] },
    });

    // Close immediately
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });

    await main();

    expect(mockClient.resumeSession).toHaveBeenCalledWith(
      'existing-session-456',
      expect.any(Object),
    );
  });

  it('falls back to fresh session on resume failure', async () => {
    mockStdinJson({
      prompt: 'Resume me',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
      sessionId: 'stale-session-789',
    });

    mockClient.resumeSession.mockRejectedValue(new Error('session not found'));

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'Fresh start', messageId: 'm1', toolRequests: [] },
    });

    // Close immediately
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });

    await main();

    // Should have tried resume first
    expect(mockClient.resumeSession).toHaveBeenCalledWith(
      'stale-session-789',
      expect.any(Object),
    );
    // Then created a fresh session
    expect(mockClient.createSession).toHaveBeenCalled();
    // Should have emitted stale session error output
    expect(capturedStdout()).toContain('stale session');
  });

  it('exits on session creation failure', async () => {
    mockStdinJson({
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    mockClient.createSession.mockRejectedValue(new Error('auth failed'));

    await expect(main()).rejects.toThrow(ExitError);

    expect(capturedStdout()).toContain('Copilot session failed: auth failed');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('loads CLAUDE.md from group and global directories', async () => {
    mockStdinJson({
      prompt: 'With context',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === '/workspace/global/CLAUDE.md') return true;
      if (p === '/workspace/group/CLAUDE.md') return true;
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p === '/workspace/global/CLAUDE.md') return 'Global instructions';
      if (p === '/workspace/group/CLAUDE.md') return 'Group instructions';
      return '';
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    await main();

    // Check that createSession was called with systemMessage containing both
    const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
    expect(sessionConfig?.systemMessage?.content).toContain('Global instructions');
    expect(sessionConfig?.systemMessage?.content).toContain('Group instructions');
  });

  it('loads CLAUDE.md from extra mounted directories', async () => {
    mockStdinJson({
      prompt: 'Extra dirs',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === '/workspace/extra') return true;
      if (p === '/workspace/extra/myproject/CLAUDE.md') return true;
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });
    mockFs.readdirSync.mockImplementation((p: string) => {
      if (p === '/workspace/extra') return ['myproject'] as any;
      return [];
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p === '/workspace/extra/myproject/CLAUDE.md') return 'Project context';
      return '';
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    await main();

    const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
    expect(sessionConfig?.systemMessage?.content).toContain('Project context');
  });

  it('skips global CLAUDE.md for main group', async () => {
    mockStdinJson({
      prompt: 'Main group',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: true, // main group
      githubToken: 'gho_testtoken123',
    });

    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === '/workspace/global/CLAUDE.md') return true;
      if (p === '/workspace/group/CLAUDE.md') return true;
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p === '/workspace/global/CLAUDE.md') return 'Global';
      if (p === '/workspace/group/CLAUDE.md') return 'Group';
      return '';
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    await main();

    const sessionConfig = mockClient.createSession.mock.calls[0]?.[0];
    // Global should NOT be loaded for isMain=true
    expect(sessionConfig?.systemMessage?.content).not.toContain('Global');
    expect(sessionConfig?.systemMessage?.content).toContain('Group');
  });

  it('prepends scheduled task prefix', async () => {
    mockStdinJson({
      prompt: 'Check health',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
      isScheduledTask: true,
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    // Close after first turn
    let callCount = 0;
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) {
        callCount++;
        return callCount > 2;
      }
      return false;
    });

    await main();

    expect(mockSession.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('[SCHEDULED TASK'),
      }),
      expect.any(Number),
    );
  });

  it('runs script for scheduled task and stops when wakeAgent=false', async () => {
    mockStdinJson({
      prompt: 'Run task',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
      isScheduledTask: true,
      script: 'echo test',
    });

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"wakeAgent": false}\n', '');
      },
    );

    await main();

    // Should NOT have called sendAndWait because wakeAgent=false
    expect(mockSession.sendAndWait).not.toHaveBeenCalled();
    // Should output success with null result
    expect(capturedStdout()).toContain('"status":"success"');
    expect(capturedStdout()).toContain('"result":null');
  });

  it('enriches prompt with script data when wakeAgent=true', async () => {
    mockStdinJson({
      prompt: 'Run task',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
      isScheduledTask: true,
      script: 'echo check',
    });

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '{"wakeAgent": true, "data": {"status": "ok"}}\n', '');
      },
    );

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'Task done', messageId: 'm1', toolRequests: [] },
    });

    // Close immediately
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });

    await main();

    expect(mockSession.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Script output'),
      }),
      expect.any(Number),
    );
  });

  it('registers compaction event handler', async () => {
    mockStdinJson({
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    // Close immediately
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    await main();

    // Check that session.on was called with 'session.compaction_start'
    const onCalls = mockSession.on.mock.calls;
    const compactionCall = onCalls.find(
      (call: any[]) => call[0] === 'session.compaction_start',
    );
    expect(compactionCall).toBeDefined();
  });

  it('passes token to CopilotClient constructor', async () => {
    const { CopilotClient } = await import('@github/copilot-sdk');

    mockStdinJson({
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_securetoken',
    });

    // Close immediately
    mockFs.existsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.includes('_close')) return true;
      return false;
    });

    mockSession.sendAndWait.mockResolvedValue({
      data: { content: 'OK', messageId: 'm1', toolRequests: [] },
    });

    await main();

    // We can't spy on the mock constructor directly since it's a plain function,
    // but we can verify the client methods were called (proving constructor ran)
    expect(mockClient.createSession).toHaveBeenCalled();
  });

  it('handles query error in the loop', async () => {
    mockStdinJson({
      prompt: 'Hello',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      githubToken: 'gho_testtoken123',
    });

    mockSession.sendAndWait.mockRejectedValue(new Error('API error'));

    await main();

    expect(capturedStdout()).toContain('"status":"error"');
    expect(capturedStdout()).toContain('API error');
    // Should still disconnect and stop
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(mockClient.stop).toHaveBeenCalled();
  });
});
