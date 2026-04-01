# Report: Tool System — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\tools\` + `src/Tool.ts` + `src/services/tools/`
> Ngày: 2026-03-31

---

## Tổng quan

Tool System là lớp giữa **Claude AI** và **môi trường thực tế** — mọi hành động Claude thực hiện (đọc file, chạy lệnh, tìm kiếm web) đều đi qua đây. Hệ thống gồm **40+ tools**, pipeline execution nghiêm ngặt, và security multi-layer đặc biệt phức tạp ở BashTool.

---

## 1. Tool Interface — Cấu trúc cơ bản

**File:** `src/Tool.ts` (~793 lines)

```typescript
type Tool<Input, Output, Progress> = {
  // Identity
  name: string
  aliases?: string[]
  searchHint?: string            // 3-10 từ cho ToolSearch deferred loading

  // Execution
  call(args, context, canUseTool, parentMessage, onProgress): Promise<Output>
  inputSchema: ZodSchema<Input>  // Zod validation
  outputSchema?: ZodSchema<unknown>

  // Behavior flags
  isConcurrencySafe(input): boolean  // Default: false (conservative)
  isReadOnly(input): boolean         // Default: false
  isDestructive(input): boolean      // Default: false
  isEnabled(): boolean               // Default: true
  interruptBehavior?(): 'cancel' | 'block'  // Default: 'block'

  // Permission
  checkPermissions(input, ctx): PermissionDecision
  validateInput(input, ctx): ValidationResult

  // Output
  maxResultSizeChars: number         // Persistence threshold
  shouldDefer?: true                 // Deferred tool (lazy-load schema)

  // Rendering
  renderToolUseMessage()
  renderToolUseProgressMessage()
  renderToolResultMessage()
  renderToolUseRejectedMessage()
  getActivityDescription()           // Spinner text
  getToolUseSummary()                // Compact label
}
```

### Defaults (buildTool helper)

```typescript
const TOOL_DEFAULTS = {
  isConcurrencySafe:  () => false,   // ← Conservative: assume not safe
  isReadOnly:         () => false,   // ← Conservative: assume writes
  isDestructive:      () => false,
  isEnabled:          () => true,
  interruptBehavior:  () => 'block', // ← Finish before aborting
  checkPermissions:   () => ({ behavior: 'allow' }),
}
```

---

## 2. Tool Registry & Loading

**File:** `src/tools.ts`

### getAllBaseTools() — Load toàn bộ tools

```typescript
// Điều kiện load theo environment:
feature('KAIROS')          → REPLTool, SleepTool, CronTools
isAgentSwarmsEnabled()     → TeamCreateTool, TeamDeleteTool
!CLAUDE_CODE_SIMPLE        → Tất cả tools đầy đủ
CLAUDE_CODE_SIMPLE=true    → Chỉ: BashTool, FileReadTool, FileEditTool
```

### 4 Tool Modes

| Mode | Tool Set | Dùng khi |
|---|---|---|
| **Default** | 40+ tools đầy đủ | Normal session |
| **Simple** | BashTool, FileRead, FileEdit | Lightweight mode |
| **REPL** | REPL wrapper (ẩn primitives) | REPL mode |
| **Coordinator** | AgentTool, TaskStopTool + specialized | Multi-agent orchestration |

### Tool Pool Assembly

```
getTools(permissionContext)
    ↓
assembleToolPool()        ← built-in tools + MCP tools
    ↓
filterToolsByDenyRules()  ← blanket deny enforcement
    ↓
Active tool pool cho session
```

---

## 3. Execution Pipeline

**File:** `src/services/tools/toolExecution.ts`

```
tool_use block (từ Anthropic API)
    │
    ├── 1. inputSchema.safeParse(input)
    │      → Validation error → reject ngay
    │
    ├── 2. validateInput(input, context)
    │      → Tool-specific validation (path checks, etc.)
    │
    ├── 3. checkPermissions(input, context)
    │      ├── 'allow'  → tiếp tục
    │      ├── 'deny'   → return REJECT_MESSAGE
    │      └── 'ask'    → show PermissionRequest UI → chờ user
    │
    ├── 4. Pre-tool hooks
    │      → Analytics, logging, state tracking
    │
    ├── 5. tool.call(args, context, canUseTool, ...)
    │      → onProgress(progressData) → UI updates realtime
    │      → return ToolResult { data, newMessages?, contextModifier? }
    │
    ├── 6. Post-tool hooks
    │      → Analytics, file state cache update
    │
    ├── 7. Result sizing check
    │      → result > maxResultSizeChars?
    │         YES → persist to .claude/tool-results/xxx.txt
    │         NO  → inline content
    │
    └── 8. mapToolResultToToolResultBlockParam()
           → tool_result block gửi về Anthropic API
```

### Error Classification

```typescript
classifyToolError(error) →
  TelemetrySafeError?    → use .telemetryMessage (obfuscation-proof)
  Node.js fs error?      → use error.code (ENOENT, EACCES, EPERM)
  Stable .name?          → use class name
  Fallback               → "Error"
```

---

## 4. Concurrency & Batching Model

**File:** `src/services/tools/toolOrchestration.ts`

### Partitioning Algorithm

```
Turn có N tool_use blocks:
    ↓
Group thành batches:

Batch 1: [Read A, Glob B, Grep C]   ← isConcurrencySafe=true → PARALLEL
Batch 2: [Bash D]                   ← isConcurrencySafe=false → SERIAL
Batch 3: [Read E, Read F]           ← isConcurrencySafe=true → PARALLEL
    ↓
MAX_TOOL_USE_CONCURRENCY = 10 (env configurable)
```

### Concurrency Properties per Tool

| Tool | isConcurrencySafe | isReadOnly | interruptBehavior |
|---|---|---|---|
| FileReadTool | ✅ Yes | ✅ Yes | cancel |
| GlobTool | ✅ Yes | ✅ Yes | cancel |
| GrepTool | ✅ Yes | ✅ Yes | cancel |
| LSPTool | ✅ Yes | ✅ Yes | cancel |
| WebFetchTool | ✅ Yes | ✅ Yes | cancel |
| BashTool | ❌ No | ❌ No | cancel |
| FileEditTool | ❌ No | ❌ No | **block** |
| FileWriteTool | ❌ No | ❌ No | **block** |
| AgentTool | ❌ No | ❌ No | cancel |
| MCPTool | Varies | Varies | Varies |

> **block** = hoàn thành file write trước khi abort → tránh corrupt

---

## 5. Permission System

**Files:** `src/hooks/toolPermission/` + `src/utils/permissions/`

### 4 Permission Modes

| Mode | Hành vi |
|---|---|
| `'default'` | Prompt user cho mỗi tool use |
| `'bypass'` | Auto-allow tất cả (nguy hiểm) |
| `'auto'` | ML classifier pre-approve, user override |
| `'plan'` | Read-only (exploration phase) |

### Permission Rule Sources (thứ tự ưu tiên)

```
'cliArg'         → Command-line flags
'policySettings' → Admin/MDM settings
'projectSettings'→ .claude/settings.json
'userSettings'   → ~/.claude/settings.json
'session'        → Runtime grants (session-only)
'hook'           → Automated allowlist/denylist từ hook scripts
```

### Permission Decision Reasons

```typescript
type PermissionDecisionReason =
  | { type: 'rule';        rule: PermissionRule }
  | { type: 'hook';        hookName: string }
  | { type: 'mode';        mode: PermissionMode }
  | { type: 'classifier' }                        // Auto-mode ML
  | { type: 'safetyCheck'; message: string }      // Security block
  | { type: 'other';       reason: string }       // Preapproved hosts
```

---

## 6. BashTool Security Architecture

**File:** `src/tools/BashTool/bashSecurity.ts` (~900 lines)

### 23 Security Checks

| ID | Check | Attack Vector |
|---|---|---|
| 1 | INCOMPLETE_COMMANDS | Dangling pipes/redirects |
| 2 | JQ_SYSTEM_FUNCTION | `jq system()` → RCE |
| 3 | OBFUSCATED_FLAGS | `\-\-help` backslash escaping |
| 4 | SHELL_METACHARACTERS | Unquoted metacharacters |
| 5 | DANGEROUS_VARIABLES | `$RANDOM`, `$$`, `$PPID` |
| 6 | NEWLINES | Literal newlines in quoted strings |
| 7 | COMMAND_SUBSTITUTION | `$(...)`, `${}`, `<(...)` process substitution |
| 8 | INPUT_REDIRECTION | `< /proc/self/environ` |
| 9 | OUTPUT_REDIRECTION | `> ~/.bashrc` |
| 10 | IFS_INJECTION | Unquoted IFS expansion |
| 11 | GIT_COMMIT_SUBSTITUTION | Repo traversal via git config |
| 12 | PROC_ENVIRON_ACCESS | `/proc/[pid]/environ` |
| 13 | MALFORMED_TOKEN_INJECTION | Shell quote parsing evasion |
| 14 | BACKSLASH_ESCAPED_WHITESPACE | `\ ` escaped space |
| 15 | BRACE_EXPANSION | `{cmd1,cmd2}` eval |
| 16 | CONTROL_CHARACTERS | NULL bytes, ASCII control codes |
| 17 | UNICODE_WHITESPACE | Homograph attacks (U+00A0) |
| 18 | MID_WORD_HASH | `foo#bar` comment injection |
| 19 | ZSH_DANGEROUS_COMMANDS | `zmodload`, `emulate`, `zpty`, `ztcp` |
| 20 | BACKSLASH_ESCAPED_OPERATORS | `\|`, `\&&` |
| 21 | COMMENT_QUOTE_DESYNC | Quote/comment nesting confusion |
| 22 | QUOTED_NEWLINE | Newlines inside quotes |
| 23 | UNC_PATH | `\\server\share` → NTLM credential leak |

### Defense Layers

```
Layer 1: Quote stripping
  extractQuotedContent() → tracks quoted context trước khi check

Layer 2: Heredoc extraction
  extractHeredocs() → isolate complex heredoc syntax

Layer 3: Shell quote parsing
  tryParseShellCommand() → via shell-quote library

Layer 4: Optional Tree-sitter AST analysis
  → Accurate AST-based validation (more expensive)

Layer 5: Zsh-specific checks
  ZSH_DANGEROUS_COMMANDS = { zmodload, emulate, sysopen, zpty, ztcp }
```

### commandSemantics.ts — Intent Classification

```typescript
isSearchOrReadCommand(command) → {
  isSearch: boolean,  // grep, find, rg, ag, fd
  isRead: boolean,    // cat, head, tail, less, wc
  isList: boolean,    // ls, dir, tree
}
// → Dùng để collapse UI (không hiện full output)
```

---

## 7. File Operation Tools

### So sánh

| Tool | Purpose | Concurrent | ReadOnly | maxResultSize |
|---|---|---|---|---|
| **FileReadTool** | Đọc text/PDF/image/notebook | ✅ | ✅ | **Infinity** |
| **FileEditTool** | String replacement in-place | ❌ | ❌ | 100K |
| **FileWriteTool** | Tạo/ghi đè file | ❌ | ❌ | 100K |
| **GlobTool** | Pattern matching files | ✅ | ✅ | 100K |
| **GrepTool** | ripgrep content search | ✅ | ✅ | **20K** |
| **NotebookEditTool** | Edit Jupyter cells | ❌ | ❌ | 100K |

### FileReadTool — `maxResultSizeChars: Infinity`

Lý do đặc biệt: File contents là source-of-truth trên disk → không cần persist lại. Nếu persist → tạo circular reference (Read → file → Read). Vẫn bị bound bởi `MAX_BUFFER_SIZE_BYTES`.

### Path Security (tất cả file tools)

```typescript
validateFilePath(path) →
  expandHome()           // ~ → /home/user
  containsPathTraversal() // ../ hoặc ..\\ → reject
  BLOCKED_DEVICE_PATHS   // /dev/zero, /dev/stdin, /proc/self/environ → reject
  isUNCPath()            // \\server\share → skip (NTLM risk)
  isDangerousFile()      // .gitconfig, .bashrc, .zshrc → warn
```

---

## 8. Special Tools

### LSPTool (Language Server Protocol)

**9 operations:**
```
goToDefinition, findReferences, hover,
documentSymbol, workspaceSymbol, goToImplementation,
prepareCallHierarchy, incomingCalls, outgoingCalls
```
- Concurrency-safe (read-only IDE operations)
- Requires `getLspServerManager()` initialization
- Routing: file extension → language → LSP server

### EnterWorktreeTool / ExitWorktreeTool

```
EnterWorktreeTool:
  → git worktree add .claude/worktrees/{name}/
  → Change CWD → isolated git environment
  → Clear system prompt cache (recompute env_info)
  → Disabled on Windows

ExitWorktreeTool:
  → Restore original CWD
  → Cleanup worktree directory
  → Re-cache system prompt
```

### EnterPlanModeTool / ExitPlanModeTool

```
Enter:
  → permissionMode: 'default' → 'plan'
  → Plan mode = read-only exploration
  → prepareContextForPlanMode() activates classifier if 'auto'

Exit:
  → Requires user approval dialog
  → Restore previous permission mode
```

### SkillTool

```
Execute skill trong forked subagent:
  → Isolated token budget
  → Merged command list (local + MCP skills)
  → Progress tracking via SkillToolProgress
  → resolveSkillModelOverride() — skill có thể override model
```

### TodoWriteTool

```
Update todo list trong AppState:
  → shouldDefer: true (lazy-load)
  → Returns old + new todos (diff)
  → Special nudge: Close 3+ tasks đồng thời mà không verify
    → Inject VerificationAgent suggestion
```

### AskUserQuestionTool

```
Interactive survey:
  → 1-4 questions
  → Multi-select support
  → Preview content cho options
  → Returns dict { question → answer }
  → UI: MessageResponse component
```

### WebFetchTool & WebSearchTool

```
WebFetchTool:
  → Fetch URL → HTML → Markdown conversion
  → Apply prompt filter
  → shouldDefer: true
  → Preapproved hosts: no permission prompt

WebSearchTool:
  → Dùng Claude API beta: web_search_20250305
  → shouldDefer: true
  → Streaming results
```

---

## 9. Deferred Tools (Lazy Schema Loading)

Để giữ system prompt nhỏ và maximize prompt cache:

```
shouldDefer: true → send với defer_loading: true (không load schema)
    ↓
Model gọi ToolSearch("keyword") trước
    ↓
ToolSearch tìm relevant tools → load schema đầy đủ
    ↓
Model gọi tool thật với schema đã biết
```

**Deferred tools:**
`WebFetchTool`, `WebSearchTool`, `NotebookEditTool`,
`EnterWorktreeTool`, `EnterPlanModeTool`, `SkillTool`, `TodoWriteTool`

**Always-load tools** (`alwaysLoad: true`):
Core tools: `BashTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GlobTool`, `GrepTool`, `AgentTool`

---

## 10. Tool Result Persistence

### Size Limits

```
BashTool:         30,000 chars
GrepTool:         20,000 chars  ← Nhỏ nhất (search results)
Most tools:      100,000 chars
FileReadTool:    Infinity        ← Không persist
```

### Persistence Flow

```
result > maxResultSizeChars?
    │
    YES → save to .claude/tool-results/{uuid}.txt
    │     Model nhận: "<content persisted to /path/to/result.txt>"
    │
    NO  → inline content trong tool_result block
```

---

## 11. Rendering Architecture

```typescript
// Mỗi tool có thể implement:
renderToolUseMessage()          // Tool input display (trước execute)
renderToolUseProgressMessage()  // Live progress (spinner, stats)
renderToolResultMessage()       // Output display
renderToolUseRejectedMessage()  // Diff khi edit bị reject
renderToolUseErrorMessage()     // Error formatting
renderGroupedToolUse()          // Batch parallel tools
getToolUseSummary()             // "found 3 files" compact label
getActivityDescription()        // "Reading src/foo.ts" spinner text
isSearchOrReadCommand()         // Collapse hint for UI
```

---

## 12. Tất cả Tools — Danh sách đầy đủ

### File Operations
- `FileReadTool` — Đọc text, PDF, image, Jupyter notebooks
- `FileEditTool` — In-place string replacement
- `FileWriteTool` — Tạo/ghi đè file
- `GlobTool` — Pattern matching
- `GrepTool` — ripgrep content search
- `NotebookEditTool` — Jupyter cell editing

### Execution
- `BashTool` — Shell commands (23-check security)
- `REPLTool` — REPL execution (KAIROS mode)
- `PowerShellTool` — PowerShell (Windows)

### Web
- `WebFetchTool` — Fetch URL → Markdown
- `WebSearchTool` — Claude native web search

### AI & Agent
- `AgentTool` — Spawn subagents (sync/async/team)
- `SkillTool` — Execute skills in forked agent
- `AskUserQuestionTool` — Interactive user survey

### Task Management
- `TaskCreateTool` — Create tasks
- `TaskUpdateTool` — Update task state + hooks
- `TaskStopTool` — Kill running agents
- `TaskListTool` — List active tasks
- `TaskOutputTool` — Read agent output

### Team / Multi-agent
- `SendMessageTool` — Agent-to-agent messaging
- `RemoteTriggerTool` — Trigger remote agents
- `TeamCreateTool` — Create team/swarm
- `TeamDeleteTool` — Dissolve team

### IDE Integration
- `LSPTool` — Language Server Protocol (9 operations)
- `MCPTool` — Model Context Protocol bridge

### Config & State
- `ConfigTool` — Manage configuration
- `TodoWriteTool` — Todo list in AppState
- `SyntheticOutputTool` — Internal structured output

### Mode Control
- `EnterPlanModeTool` — Switch to plan (read-only) mode
- `ExitPlanModeTool` — Exit plan mode
- `EnterWorktreeTool` — Enter git worktree isolation
- `ExitWorktreeTool` — Exit git worktree

### Search
- `ToolSearchTool` — Deferred tool schema loading

---

## 13. Key Architectural Insights

### 1. Conservative Defaults
```
isConcurrencySafe = false  → assume không safe
isReadOnly        = false  → assume có write
interruptBehavior = 'block'→ assume data integrity needed
```

### 2. Tiered Validation
```
inputSchema.parse() → validateInput() → checkPermissions() → call()
```
Mỗi tầng có thể reject trước khi đến tầng tiếp theo.

### 3. Security Defense-in-Depth (BashTool)
```
23 text-pattern checks
+ Quote stripping (track quoted context)
+ Heredoc extraction
+ Shell quote parsing (library)
+ Optional Tree-sitter AST
```

### 4. Deferred Tools = System Prompt Cache Optimization
Tools ít dùng không load schema → system prompt nhỏ hơn → cache hit rate cao hơn → cost thấp hơn.

### 5. Infinity maxResultSize (FileReadTool)
Intentional design: file là source-of-truth, persist lại chỉ tạo redundancy + circular reference.

### 6. Result Persistence = Token Budget Management
Large outputs → file → model chỉ thấy reference path. Giảm context window bloat từ tool results.

---

## Files Chính

| File | Trách nhiệm |
|---|---|
| `src/Tool.ts` | Base interface, types, buildTool helper |
| `src/tools.ts` | Registry, loading, getAllBaseTools() |
| `src/services/tools/toolExecution.ts` | Execution pipeline, error handling |
| `src/services/tools/toolOrchestration.ts` | Concurrency batching |
| `src/hooks/toolPermission/` | Permission checks, PermissionContext |
| `src/utils/permissions/` | Permission rules, decision reasons |
| `src/tools/BashTool/bashSecurity.ts` | 23 security checks |
| `src/tools/BashTool/commandSemantics.ts` | Intent classification |
| `src/tools/shared/` | Shared utilities (path validation, etc.) |

---

## Kết luận

Tool System của Claude Code là kiến trúc **defense-in-depth** với:

1. **Conservative defaults** — assume nguy hiểm, require explicit opt-in cho concurrent/read-only
2. **Tiered validation** — 3 tầng check trước khi execute
3. **23-check Bash security** — text + AST + quote-aware parsing
4. **Dynamic concurrency** — auto-batch concurrent-safe tools
5. **Deferred loading** — lazy-load schema để tối ưu prompt cache
6. **Result persistence** — large outputs → disk, model nhận reference
7. **Interrupt safety** — 'block' behavior đảm bảo file write hoàn thành trước abort
8. **Telemetry-safe errors** — obfuscation-proof error classification
