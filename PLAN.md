# Plan: Copilot Provider — Functionality Gap Report

## Purpose

Comprehensive audit of every functional difference between `main` (Claude Agent SDK) and `copilot-provider` (GitHub Copilot SDK) branches of `container/agent-runner/src/index.ts` and related host-side code. Each item traced to its git origin, assessed for user-facing impact.

## Grading Scale

| Grade | Meaning |
|-------|---------|
| 🔴 P0 | **Broken functionality** — feature exists on main, will error or silently fail on copilot-provider |
| 🟠 P1 | **Missing capability** — feature works on main, absent on copilot-provider, users will notice |
| 🟡 P2 | **Degraded behavior** — works on both, but copilot-provider is worse in a specific way |
| 🟢 P3 | **Cosmetic / low-risk** — minor difference, most users won't encounter it |
| ⚪ OK | **Equivalent or improved** — no gap |

---

## GAP-01: Extra Directory Mounts Not Loaded Into Context
**Grade: 🟠 P1**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Scans `/workspace/extra/*`, passes as `additionalDirectories` to SDK. CLAUDE.md files in mounted dirs auto-loaded. | Not implemented. `/workspace/extra/*` mounts exist but their CLAUDE.md files are never read. |
| **Affected users** | Anyone using `containerConfig.additionalMounts` on a group (e.g. mounting a codebase for the agent to reference) |

**Git origin:** `b5a6757` — _"fix: pass requiresTrigger through IPC and auto-discover additional directories"_
> Agent runner scans /workspace/extra/* and passes them as additionalDirectories to the SDK query, so CLAUDE.md files in mounted dirs are loaded automatically

**Why it matters:** This is how groups get external context injected. A user mounts their project repo at `/workspace/extra/myproject` so the agent can read its CLAUDE.md for project-specific instructions. Without this, the agent is blind to those instructions.

**Fix complexity:** Low — read CLAUDE.md from each extra dir and append to `systemParts[]`.

---

## GAP-02: Conversation Archiving (PreCompact Hook)
**Grade: 🟠 P1**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Before context compaction, archives full transcript to `/workspace/group/conversations/{date}-{name}.md` as readable markdown. | No archiving. Conversations are lost when compacted. |
| **Affected users** | Any user who wants conversation history preserved |

**Git origin:** `9558bdf` — _"skill/compact: /compact session command for context compaction"_
> Added 100 lines to agent-runner: `createPreCompactHook()`, `parseTranscript()`, `formatTranscriptMarkdown()`, `getSessionSummary()`, `sanitizeFilename()`, `generateFallbackName()`

**Why it matters:** Long conversations get compacted automatically. Main preserves the full conversation as a markdown file before compaction. Copilot discards it. Users lose the ability to review past conversations.

**Fix complexity:** Medium — Copilot SDK has different session events. Need to find equivalent hook point or implement periodic archiving. Transcript format differs.

---

## GAP-03: Mid-Turn Message Injection (Real-Time vs Buffered)
**Grade: 🟡 P2**

| | Main | Copilot |
|---|---|---|
| **Behavior** | `MessageStream.push()` injects follow-up messages into the active query in real-time. Agent sees them during the current turn. | Messages buffered in `bufferedMessages[]`, replayed as next prompt after turn completes. |
| **Affected users** | Users who send rapid follow-up messages while the agent is thinking |

**Git origin:** `6f02ee5` — _"Adds Agent Swarms"_
> Agent runner: query loop with AsyncIterable prompt to keep stdin open for agent teams (fixes isSingleUserTurn premature shutdown)

**Why it matters:** On main, if you send "also check the logs" while the agent is working, it sees that immediately. On copilot-provider, it arrives as a separate turn after the current work finishes. Functionally equivalent (no message loss), but introduces a delay. The buffered approach was specifically added in our fork to prevent the message-dropping bug the critic identified.

**Fix complexity:** N/A — this is an inherent SDK architectural difference. `sendAndWait()` is request/response; there's no way to inject mid-turn. The buffered approach is the correct solution.

---

## GAP-04: Remote Control (`/remote-control` Command)
**Grade: 🔴 P0**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Spawns `claude remote-control` on the host, returns a URL for browser-based Claude Code access. | Code exists but spawns `claude` binary which doesn't exist. Returns "Failed to start: spawn claude ENOENT". |
| **Affected users** | Anyone using `/remote-control` command |

**Git origin:** `e2b0d2d` — _"feat: add /remote-control command for host-level Claude Code access"_
> Users can send /remote-control from the main group in any channel to spawn a detached `claude remote-control` process on the host. The session URL is sent back through the channel.

**Why it matters:** This feature gives users direct browser access to Claude Code through NanoClaw. It's fundamentally Claude-specific — spawns the `claude` CLI binary. Will error on copilot-provider since no `claude` binary exists. The error is graceful (returns error message, doesn't crash), but the feature is dead.

**Fix complexity:** High — would need Copilot equivalent (if one exists) or feature removal. No known `copilot remote-control` equivalent in the SDK.

---

## GAP-05: Agent Swarms / Teams Support
**Grade: 🟡 P2**

| | Main | Copilot |
|---|---|---|
| **Behavior** | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'` in `.claude/settings.json`. `TeamCreate`/`TeamDelete`/`SendMessage` in allowedTools. `MessageStream` keeps session alive for subagents. | No explicit teams config. Copilot CLI has its own agent orchestration, but behavior may differ. `approveAll` permits all tools by default. |
| **Affected users** | Users running the Telegram Swarm skill or agent orchestration workflows |

**Git origin:** `6f02ee5` — _"Adds Agent Swarms"_
> Per-group settings.json with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, SDK bumped to 0.2.34 for TeamCreate tool support

**Why it matters:** Main explicitly enables Claude Code's experimental agent teams feature and exposes orchestration tools. Copilot CLI may have equivalent functionality (it has Task tool), but the behavior is SDK-specific and untested. The Telegram Swarm skill (`/add-telegram-swarm`) specifically depends on this.

**Fix complexity:** Medium — need to verify Copilot CLI's agent orchestration capabilities and whether they map to the same use cases.

---

## GAP-06: Env Var Sanitization (Security)
**Grade: 🟢 P3**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Commit `1a07869` added PreToolUse hook to prepend `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` to every Bash command. Commit `1549ad5` passes secrets via SDK `env` option so Bash subprocesses never inherit API keys. | Token passed as `COPILOT_GITHUB_TOKEN` env var. No explicit sanitization. Container Bash commands could read it via `echo $COPILOT_GITHUB_TOKEN`. |
| **Affected users** | Security-sensitive deployments |

**Git origin:**
- `1a07869` — _"security: sanitize env vars from agent Bash subprocesses (#171)"_
  > Use a PreToolUse SDK hook to prepend `unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN` to every Bash command
- `1549ad5` — _"security: pass secrets via SDK env option and delete temp file (#213)"_
  > Pass secrets to the SDK via the `env` query option instead of setting process.env

**Why it matters:** On main, the agent literally cannot access the API key even if it tries `echo $ANTHROPIC_API_KEY` — it's unset before every Bash command. On copilot-provider, the token is in the environment and a determined (or confused) agent could read it. Risk is low because containers are ephemeral and isolated, but it's a security regression.

**Fix complexity:** Low — the CopilotClient constructor accepts `githubToken` option. If the SDK passes it internally without setting `process.env`, this is already solved. Otherwise, add a Bash env sanitizer.

---

## GAP-07: Tool Allowlist (Explicit vs Implicit)
**Grade: ⚪ OK**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Explicit list of 22 allowed tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage, TodoWrite, ToolSearch, Skill, NotebookEdit, mcp__nanoclaw__* | All tools available by default (Copilot CLI enables everything). `approveAll` approves all permission requests. |
| **Affected users** | N/A |

**Git origin:** Original agent-runner, iterated across many commits.

**Why it matters:** Main uses an allowlist as defense-in-depth — if Claude Code adds a dangerous new tool, NanoClaw won't auto-enable it. Copilot's `approveAll` is more permissive. In practice, both approaches give the agent full access. The risk difference is theoretical (a future Copilot tool that's dangerous by default).

**Fix complexity:** N/A — acceptable as-is. Copilot CLI's tool model is different; no equivalent allowlist mechanism.

---

## GAP-08: Settings Sources Loading
**Grade: 🟢 P3**

| | Main | Copilot |
|---|---|---|
| **Behavior** | `settingSources: ['project', 'user']` tells Claude SDK to load settings from `.claude/settings.json` (project level) and `~/.claude/settings.json` (user level). | No equivalent. Copilot CLI reads its own config files from `~/.copilot/`. |
| **Affected users** | Users with custom Claude Code settings (e.g., per-project tool configs) |

**Git origin:** Part of original agent-runner SDK query options.

**Why it matters:** Main loads the `.claude/settings.json` that the container-runner writes (with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, etc.). On copilot-provider, this file isn't written and Copilot CLI uses its own config format. The `.claude/settings.json` feature is Claude-specific and has no direct analog.

**Fix complexity:** N/A — Copilot CLI has its own configuration system. The settings that were in `.claude/settings.json` (agent teams, auto-memory) need to be expressed through Copilot SDK config if equivalents exist.

---

## GAP-09: Session Resume Granularity (resumeAt UUID)
**Grade: 🟡 P2**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Tracks `lastAssistantUuid` from each assistant message. Resumes at exact message using `resumeSessionAt: uuid`. Prevents replaying already-seen messages. | `client.resumeSession(id, config)` — SDK manages resume point internally. No granular control. |
| **Affected users** | Multi-turn conversations where the host needs to resume from a specific point |

**Git origin:** `6f02ee5` — _"Adds Agent Swarms"_ (part of the streaming/IPC architecture)

**Why it matters:** On main, after each query, the host knows exactly which message to resume from. If the container restarts mid-conversation, it picks up from the exact point. On copilot-provider, the SDK handles resume internally, which should be functionally equivalent — but we can't verify without runtime testing.

**Fix complexity:** N/A — SDK handles it. May need runtime validation to confirm behavior matches.

---

## GAP-10: Stale Session Error Regex
**Grade: 🟡 P2**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Host-side regex: `/no conversation found\|ENOENT.*\.jsonl\|session.*not found/i` catches Claude-specific error patterns. | Same regex exists (host-side code unchanged), but Copilot SDK will produce different error messages. Regex may never match. |
| **Affected users** | Users hitting stale session bugs (container crash mid-write, disk full, etc.) |

**Git origin:** `474346e` — _"fix: recover from stale Claude Code session IDs instead of retrying infinitely"_
> When Claude Code exits with code 1 during a session resume, the group's session ID is now cleared

**Why it matters:** The stale session recovery is a critical resilience feature that prevents infinite retry loops. The detection regex is Claude-specific (`.jsonl`, "no conversation found"). Copilot SDK errors will have different text. The recovery mechanism exists but the trigger pattern won't match, so stale sessions could cause retries.

**Fix complexity:** Low — update regex to match Copilot SDK error messages once observed.

---

## GAP-11: Multiple Results Per Turn
**Grade: 🟡 P2**

| | Main | Copilot |
|---|---|---|
| **Behavior** | `for await (const message of query(...))` emits multiple `result` messages per query. Each `result` triggers a `writeOutput()`. Agent teams can produce multiple results. | `session.sendAndWait()` returns a single response. One `writeOutput()` per turn. |
| **Affected users** | Agent swarm/teams workflows where subagents produce intermediate results |

**Git origin:** `6f02ee5` — _"Adds Agent Swarms"_
> Streaming output: parse OUTPUT_START/END markers in real-time, send results as they arrive

**Why it matters:** On main, when the agent delegates to subagents, each subagent's result is streamed to the user as it completes. On copilot-provider, the user sees one combined response after the entire turn finishes. This means longer perceived latency for complex multi-step tasks.

**Fix complexity:** Medium — could use `session.on('assistant.message', ...)` event listener to stream intermediate results if the SDK emits them.

---

## GAP-12: Auto-Memory Setting
**Grade: 🟢 P3**

| | Main | Copilot |
|---|---|---|
| **Behavior** | `CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0'` explicitly enables Claude's memory feature (persists user preferences between sessions). | No equivalent config. Copilot CLI may have its own memory/preferences system. |
| **Affected users** | Users who benefit from Claude remembering preferences across sessions |

**Git origin:** `6f02ee5` (part of `.claude/settings.json` written by container-runner)

**Why it matters:** Claude Code's auto-memory learns user preferences (coding style, preferred tools, etc.) across sessions. If Copilot CLI lacks this feature, the agent starts "cold" every time. Low impact since per-group CLAUDE.md already captures most persona/memory.

**Fix complexity:** N/A — depends on Copilot CLI capabilities. May not have equivalent.

---

## GAP-13: Credential Proxy Architecture
**Grade: ⚪ OK (Improved)**

| | Main | Copilot |
|---|---|---|
| **Behavior** | Complex credential proxy chain: OneCLI gateway (or native credential proxy) intercepts container API requests and injects `ANTHROPIC_API_KEY` or OAuth token. No secrets in container env. | Simple: `COPILOT_GITHUB_TOKEN` env var injected directly. No proxy needed. |
| **Affected users** | N/A — this is simpler on copilot-provider |

**Git origin:**
- `13ce4aa` — _"feat: enhance container environment isolation via credential proxy (#798)"_
- `e936961` — _"feat: replace credential proxy with OneCLI gateway"_
- `4925675` — _"skill: replace OneCLI gateway with native credential proxy"_

**Why it matters:** Main went through 3 iterations of credential management (direct env → credential proxy → OneCLI → back to credential proxy). Copilot-provider skips all of this with a simple env var. The token is a GitHub PAT (rotatable, scopeable) rather than an Anthropic API key. This is a **simplification, not a regression**.

**Fix complexity:** N/A — this is intentionally simpler.

---

## Summary Table

| # | Gap | Grade | Impact | Fix Effort |
|---|-----|-------|--------|------------|
| 01 | Extra directory CLAUDE.md loading | 🟠 P1 | Missing context for groups with extra mounts | Low |
| 02 | Conversation archiving (PreCompact) | 🟠 P1 | Conversations lost on compaction | Medium |
| 03 | Mid-turn message injection | 🟡 P2 | Slight delay, no message loss | N/A (inherent) |
| 04 | Remote Control command | 🔴 P0 | Feature errors on use | High (or remove) |
| 05 | Agent Swarms/Teams config | 🟡 P2 | Swarm behavior untested | Medium |
| 06 | Env var sanitization | 🟢 P3 | Token readable in Bash | Low |
| 07 | Tool allowlist | ⚪ OK | No gap | N/A |
| 08 | Settings sources loading | 🟢 P3 | Claude-specific, no analog | N/A |
| 09 | Session resume granularity | 🟡 P2 | SDK handles it, unverified | N/A (runtime test) |
| 10 | Stale session error regex | 🟡 P2 | Recovery may not trigger | Low |
| 11 | Multiple results per turn | 🟡 P2 | Slower perceived latency | Medium |
| 12 | Auto-memory setting | 🟢 P3 | Agent starts "cold" | N/A |
| 13 | Credential proxy | ⚪ OK | Simpler, not worse | N/A |

### By Priority

- **🔴 P0 (1):** Remote Control — dead feature, needs removal or replacement
- **🟠 P1 (2):** Extra dirs, conversation archiving — functional gaps users will notice
- **🟡 P2 (5):** Mid-turn injection, swarms, session resume, stale session regex, multi-result streaming — behavioral differences, mostly inherent to SDK
- **🟢 P3 (3):** Env sanitization, settings sources, auto-memory — low-risk, most users won't encounter
- **⚪ OK (2):** Tool allowlist, credential proxy — no gap or improved

**Target experience:** 60 seconds from `git clone` to a working NanoClaw agent, using only a GitHub account with Copilot access.

## Approach

**Fork** NanoClaw and replace the Claude Agent SDK with the **official GitHub Copilot SDK** (`@github/copilot-sdk`) natively. Not a skill branch — a fork that can seamlessly merge upstream NanoClaw improvements.

```
Upstream:  Container → Claude Agent SDK → query() → OneCLI → api.anthropic.com
Fork:      Container → Copilot SDK → session.sendAndWait() → GitHub Copilot API
```

**Key decisions (from eng review):**
- **Architecture:** Option C — Native Copilot SDK + extracted utilities
- **Agent-runner:** Full divergence accepted (Issue #3: 3A)
- **OneCLI:** Removed entirely (Issue #4: 4A) — single env var auth
- **Auth:** Fail-fast at startup if token missing (Issue #5: 5A)
- **Credential model:** Capability-based, credential-free containers

**Rejected alternatives:**
- `copilot-api` npm package — violates GitHub ToS
- Skill branch — user wants seamless upstream merges, not merge/rebuild workflow
- Adapter pattern — adds indirection; native SDK is cleaner

## Architecture

```
┌─────────────────────┐     ┌─────────────────────────────────────┐
│  Host (NanoClaw)     │     │  Container                           │
│  src/index.ts        │────▶│  agent-runner/src/index.ts            │
│  src/config.ts       │     │  import { CopilotClient } from sdk   │
│  COPILOT_GITHUB_     │─env─│  session.sendAndWait() → GitHub API  │
│  TOKEN injection     │     │  Built-in tools + NanoClaw MCP       │
│  (no OneCLI needed)  │     │  copilot CLI (npm install -g)        │
└─────────────────────┘     └─────────────────────────────────────┘
```

### Simplifications vs. upstream
- No OneCLI proxy process on host
- No boot race condition (no proxy to wait for)
- No port binding / container-to-host networking for credentials
- One env var for auth (`COPILOT_GITHUB_TOKEN`)
- Fewer host-side dependencies (`@onecli-sh/sdk` removed)

### Files Changed (6 files)

| File | Change | Merge risk |
|------|--------|-----------|
| `container/Dockerfile` | Swap claude-code for copilot | Low — rarely changes upstream |
| `container/agent-runner/package.json` | Swap SDK dep | Low — dep changes are auto-resolved |
| `container/agent-runner/src/index.ts` | **Full rewrite** | High — manual merge (3A accepted) |
| `src/container-runner.ts` | Remove OneCLI, inject token | Medium — surgical, ~20 lines |
| `src/config.ts` | Add COPILOT_*, remove ONECLI_URL | Low — additive changes |
| `src/index.ts` | Remove OneCLI, add token check | Medium — surgical, ~30 lines |

### Authentication
- `COPILOT_GITHUB_TOKEN` env var (from `gh auth token` after `gh auth login`)
- Supports `gho_*`, `ghu_*`, `github_pat_*` tokens (NOT classic `ghp_*`)
- Fail-fast at startup if missing (5A)
- Auto-refresh handled by Copilot CLI in container

## Implementation Todos

### Phase 0: Validate SDK

**validate-copilot-sdk** — Install `@github/copilot-sdk`, confirm it exports the APIs we need. Verify npm package exists and is installable.

### Phase 1: Fork Changes

**update-dockerfile** — Swap `@anthropic-ai/claude-code` for `@github/copilot` in Dockerfile.

**update-agent-deps** — Replace `@anthropic-ai/claude-agent-sdk` with `@github/copilot-sdk` in agent-runner `package.json`.

**rewrite-agent-runner** — Full rewrite of `container/agent-runner/src/index.ts`:
- Replace Claude SDK `query()` with Copilot SDK session-based API
- Keep IPC polling, output protocol, script runner, conversation archiving
- Map system prompt, MCP servers, permission bypass
- Handle streaming events → OUTPUT_START/END protocol

**modify-container-runner** — In `src/container-runner.ts`:
- Remove `@onecli-sh/sdk` import and OneCLI usage
- Replace `onecli.applyContainerConfig()` with `-e COPILOT_GITHUB_TOKEN=...`
- Keep all volume mounts, IPC paths, group isolation

**update-config** — In `src/config.ts`:
- Add `COPILOT_GITHUB_TOKEN` (required)
- Add `COPILOT_MODEL` (default: `gpt-4.1`)
- Remove `ONECLI_URL`

**update-index** — In `src/index.ts`:
- Remove OneCLI imports and `ensureOneCLIAgent()` calls
- Remove OneCLI agent reconciliation loop
- Add startup validation for `COPILOT_GITHUB_TOKEN`

**update-host-deps** — Remove `@onecli-sh/sdk` from host `package.json`.

**update-tests** — Fix `container-runner.test.ts` to remove OneCLI mocks and test token injection. All 246 existing tests must pass.

**build-and-verify** — `npm run build` + `npm test` pass clean.

## What Already Exists (reused, not rebuilt)

- IPC protocol (file-based messaging, _close sentinel) — unchanged
- Output protocol (OUTPUT_START/END markers) — unchanged
- MCP server (`ipc-mcp-stdio.ts`) — unchanged, SDK-agnostic
- Container mount system — unchanged
- Channel system (Telegram, Slack, Discord, etc.) — unchanged
- Group queue, task scheduler, database — unchanged
- All 28/29 skills — unchanged

## NOT in Scope (v1)

- Agent Swarms/Teams support (GAP-05) — explicitly de-scoped, requires runtime testing with real tokens. Exit criteria: when container runs successfully, test Copilot CLI agent orchestration and compare to Claude's TeamCreate/TeamDelete/SendMessage tools.
- Multi-provider hot-swap
- BYOK configuration
- Apple Container-specific testing

## What Already Exists (reused, not rebuilt)

- IPC protocol (file-based messaging, _close sentinel) — unchanged
- Output protocol (OUTPUT_START/END markers) — unchanged
- MCP server (`ipc-mcp-stdio.ts`) — unchanged, SDK-agnostic
- Container mount system — unchanged
- Channel system (Telegram, Slack, Discord, etc.) — unchanged
- Group queue, task scheduler, database — unchanged
- All 28/29 skills — unchanged
- Stale session recovery logic (host-side) — reused with updated detection

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Copilot SDK v0.2.1 is pre-1.0, API may break | High | Pin exact version, test before upgrading |
| SessionCompactionStartEvent untested in Node SDK | Medium | Smoke integration test validates |
| resumeSession bug #540 (unresponsive sessions) | Medium | Timeout-based retry with session recreation |
| Agent-runner merge conflicts | Medium | One file diverges; manual merge ~5min |
| Rate limits differ from Anthropic | Low | Document limits; users know their plan |

## SDK Upgrade Policy (TODO)

1. Pin exact versions in package.json (no `^` or `~` for pre-1.0 SDKs)
2. Test locally before upgrading: `npm test` + container smoke test
3. Read SDK changelog for breaking changes before each upgrade
4. Track github/copilot-sdk releases for security patches
5. Document any SDK workarounds with the version they apply to

## Acceptance Criteria

1. `npm run build` succeeds ✅ (verified)
2. All 246+ existing tests pass ✅ (verified)
3. Agent-runner unit tests pass with 100% coverage (NEW — mocked SDK)
4. Smoke integration test: container starts, authenticates, responds to prompt
5. Session resumes across container restarts
6. Extra dir CLAUDE.md context is visible to agent in responses
7. Conversation archived to `/workspace/group/conversations/` before compaction
8. Token NOT visible in container env vars (only via stdin → constructor)
9. Stale session detected via timeout, session recreated automatically
10. No ToS violations

## Gap Closure — Eng Review Decisions

### Architecture Decisions (Section 1)
- **Issue #1: GAP-04 Remote Control** → Remove entirely. Dead code (-250 lines). No Copilot equivalent exists. Graceful error, not crash, but confusing to leave. **Decision: A — Remove.**
- **Issue #2: GAP-10 Stale Session** → Timeout-based retry, NOT regex. Copilot SDK's failure mode is unresponsive sessions (bug #540), not file-not-found errors. Regex approach is architecturally wrong for Copilot. **Decision: timeout + recreate.**
- **Issue #3: GAP-06 Token Security** → Pass via stdin (ContainerInput JSON) + CopilotClient({ githubToken }) constructor. Token never touches environment. Matches main's security posture. **Decision: A — stdin + constructor.**

### Code Quality Decisions (Section 2)
- **Issue #4: Model config channel** → Keep COPILOT_MODEL in env var. Secrets via stdin, config via env. Standard 12-factor pattern. **Decision: B — env var.**

### Test Plan (Section 3)
- **Target: 100% code coverage** for agent-runner
- New vitest suite in `container/agent-runner/` with full Copilot SDK mocking
- 19 container-side test cases needed (all functions and branches)
- 2 host-side test updates (token in ContainerInput, not in Docker -e args)
- 1 smoke integration test (build container, send prompt, verify response)
- **Add vitest + devDependencies to agent-runner/package.json**

### Performance (Section 4)
- No concerns. All changes are startup-time or infrequent operations.

### Codex Outside Voice Findings
Key additions from independent review:
- ✅ Pin exact SDK version (accepted — change `^0.2.1` to `0.2.1`)
- ✅ Add smoke integration test (accepted — 1 real container test)
- ✅ De-scope agent swarms to v2 (accepted — explicit exit criteria)
- ✅ Token log redaction (accepted — add to GAP-06 fix)
- ✅ Acceptance criteria (accepted — 10 items defined above)
- ❌ SDK adapter layer (rejected — over-engineered for solo fork)
- ❌ Migration/rollback strategy (rejected — fork branch, not production)

### Failure Modes

| Codepath | Failure Mode | Has Test | Has Error Handling | User Impact |
|----------|-------------|----------|-------------------|-------------|
| Extra dir scan | /workspace/extra missing | Planned | existsSync guard | Silent — no extra context |
| CLAUDE.md read | Permission error | Planned | try/catch | Silent — context skipped |
| Compaction event | Event never fires (SDK bug) | Planned | N/A | Silent — no archive |
| Archive write | Disk full | Planned | try/catch | Silent — archive fails |
| Token missing | ContainerInput.token undefined | Planned | Fail-fast | Clear error |
| Resume timeout | sendAndWait hangs | Planned | Timeout → recreate | Delayed response |
| Delete + recreate | Session state corrupt | Planned | Error propagation | Error message |

**Critical gaps: 0** — all failure modes covered by test plan or error handling.

### TODOs (from review)
1. **Token log redaction** — Add regex redaction to agent-runner log() for gho_*/ghu_*/github_pat_* patterns. Part of GAP-06 fix.
2. **Acceptance criteria** — 10 items defined above. Verify each during implementation.
3. **SDK upgrade policy** — Document upgrade process for pre-1.0 SDK. Write to PLAN.md or CONTRIBUTING.md.

## Eng Review #2 Completion Summary

- **Step 0: Scope** — 7 actionable gaps, 6 accepted for v1, 1 (swarms) de-scoped to v2.
- **Architecture Review:** 3 issues found, 3 resolved.
  - #1: Remove remote-control entirely (A) ✓
  - #2: Timeout-based stale session retry ✓
  - #3: Token via stdin + constructor (A) ✓
- **Code Quality Review:** 1 issue found, 1 resolved.
  - #4: Keep model in env var (B) ✓
- **Test Review:** Diagram produced, 21 gaps identified. 100% coverage target with mock + smoke test.
- **Performance Review:** 0 issues found.
- **NOT in scope:** Written (swarms, hot-swap, BYOK, Apple Container).
- **What already exists:** Written (IPC, output protocol, MCP, mounts, channels, skills).
- **TODOS:** 3 items proposed, 3 accepted.
- **Failure modes:** 7 analyzed, 0 critical gaps.
- **Outside voice:** Ran (codex). 12 findings, 5 adopted, 2 rejected.
- **Lake Score:** 8/8 decisions chose complete option.
- **Unresolved decisions:** 0.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 12 findings, 5 adopted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**UNRESOLVED:** 0 decisions across all reviews.
**VERDICT:** ENG CLEARED — ready to implement. Run `/ship` when done.
