# Plan: NanoClaw Fork — GitHub Copilot Edition

## Problem

NanoClaw requires an Anthropic subscription or API key. Users with GitHub Copilot subscriptions can't use NanoClaw today. This is the #1 community feature request (Issue #80, 56 upvotes; Issue #1350 specifically for Copilot).

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

- Remote Control (`src/remote-control.ts`) — Claude Code-specific host feature; fails gracefully if invoked
- Session resume (Copilot SDK uses different mechanism — v2)
- PreCompact hook parity (Copilot has auto-compaction at 95%)
- Conversation archiving (depends on Claude SDK transcript format — v2)
- Multi-provider hot-swap
- BYOK configuration
- Apple Container-specific testing

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Copilot SDK API differs from research | High | Phase 0 validates before any code changes |
| Session resume gap | Medium | v1 works without resume; v2 adds it |
| Agent-runner merge conflicts | Medium | One file diverges; manual merge ~5min with CC |
| Token visible in container env | Low | Container is ephemeral; token is rotatable |
| Rate limits differ from Anthropic | Low | Document limits; users know their plan |

## Success Criteria

1. `npm run build` succeeds
2. All 246+ existing tests pass
3. Container starts and authenticates via `COPILOT_GITHUB_TOKEN`
4. Agent responds to messages through configured channels
5. Built-in tools work (Bash, Read, Write, Edit, Glob, Grep)
6. NanoClaw IPC MCP server works (status updates, task scheduling)
7. No ToS violations

## Eng Review Completion Summary

- **Step 0: Scope** — 6 files changed, under threshold. Scope accepted.
- **Architecture (Section 1):** 3 issues resolved
  - #1: Native Copilot SDK + extracted utilities (Option C) ✓
  - #2: OneCLI proxy — Phase 0 validation (moot — OneCLI removed per #4) ✓
  - #3: Fork merge strategy — full divergence for agent-runner (3A) ✓
- **Code Quality (Section 2):** 2 issues resolved
  - #4: Remove OneCLI entirely (4A) ✓
  - #5: Fail-fast on missing token (5A) ✓
- **Test Review (Section 3):** Host-side tests need OneCLI mock removal. Agent-runner has no tests (runs inside container). Coverage maintained by fixing existing test file.
- **Performance (Section 4):** No concerns — fork removes a proxy hop (faster, not slower).
- **Failure modes:** Token expiry → clear error from Copilot CLI. Missing token → startup failure (5A). API rate limit → agent-level error, host retries.
- **Lake Score:** 5/5 decisions chose complete option

## Implementation Status

**All planned changes complete.** Build clean, 246/246 tests pass.

### Files Changed (final list)

| File | Change | Status |
|------|--------|--------|
| `container/Dockerfile` | Swap claude-code for copilot CLI | ✅ |
| `container/agent-runner/package.json` | Swap SDK dep to `@github/copilot-sdk` | ✅ |
| `container/agent-runner/package-lock.json` | Removed stale lockfile (regenerated at build) | ✅ |
| `container/agent-runner/src/index.ts` | Full rewrite for Copilot SDK | ✅ |
| `src/container-runner.ts` | Remove OneCLI, inject token, `.copilot` dir | ✅ |
| `src/config.ts` | Add COPILOT_*, remove ONECLI_URL | ✅ |
| `src/index.ts` | Remove OneCLI, add fail-fast token check | ✅ |
| `package.json` | Remove `@onecli-sh/sdk` | ✅ |
| `src/container-runner.test.ts` | Remove OneCLI mocks, add Copilot config | ✅ |
| `container/skills/status/SKILL.md` | `claude` → `copilot` references | ✅ |
| `container/skills/capabilities/SKILL.md` | `.claude/skills` → `.copilot/skills` | ✅ |

### Post-Critic Fixes

Issues caught by independent critic review and resolved:

1. **CLI resolution** — Added `cliPath: 'copilot'` to `CopilotClient` so SDK finds globally-installed binary
2. **Dropped follow-up messages** — Mid-turn IPC messages now buffered and used as next prompt
3. **Per-group memory** — Both global and group `CLAUDE.md` loaded into system message
4. **Stale Claude refs** — Fixed `status/SKILL.md` and `capabilities/SKILL.md` container skills
