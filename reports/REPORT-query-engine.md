# Report: QueryEngine — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\QueryEngine.ts` + `src/query/`
> Ngày: 2026-03-31

---

## Tổng quan

`QueryEngine` là **orchestrator trung tâm** của Claude Code — điều phối toàn bộ conversation lifecycle từ user input đến LLM response, tool execution, error recovery, và memory operations.

**Quy mô:** ~46,000 lines (QueryEngine.ts) + query/ directory

**Public API — chỉ 3 items:**
```typescript
class QueryEngine {
  submitMessage(prompt, options?): AsyncGenerator  // Entry point chính
  interrupt(): void                                // Hủy turn đang chạy
  getMessages(): Message[]
  getReadFileState(): FileStateCache
  getSessionId(): string
  setModel(model: string): void
}

function query(params: QueryParams): AsyncGenerator   // Core loop
function ask(prompt, options?): Promise<Result>        // One-shot wrapper
```

---

## 1. Main Query Loop

```
submitMessage(prompt)
    │
    ├── processUserInput()         ← xử lý /slash commands, permission rules
    │   └── returns: messages, model override, allowed tools
    │
    ├── recordTranscript(messages) ← lưu session storage
    │
    └── query() ─── VÒNG LẶP CHÍNH ─────────────────────────────────┐
                                                                      │
         ┌── Iteration Setup ──────────────────────────────────────┐ │
         │  getMessagesAfterCompactBoundary()                      │ │
         │  applyToolResultBudget()     (giới hạn kích thước)      │ │
         │  snipCompactIfNeeded()       (HISTORY_SNIP optimization)│ │
         │  microcompactMessages()      (filter cached tool calls) │ │
         │  autoCompactIfNeeded()       (nếu token > threshold)    │ │
         └─────────────────────────────────────────────────────────┘ │
                   │                                                  │
         ┌── CALL MODEL ───────────────────────────────────────────┐ │
         │  queryModelWithStreaming()                               │ │
         │  Stream: message_start → content_delta                  │ │
         │          → message_delta → message_stop                 │ │
         └─────────────────────────────────────────────────────────┘ │
                   │                                                  │
         ┌── TOOL EXECUTION ───────────────────────────────────────┐ │
         │  StreamingToolExecutor.getRemainingResults()             │ │
         │  Concurrent-safe tools   → chạy song song               │ │
         │  State-modifying tools   → chạy tuần tự                 │ │
         └─────────────────────────────────────────────────────────┘ │
                   │                                                  │
         ┌── STOP HOOKS ───────────────────────────────────────────┐ │
         │  handleStopHooks()                                       │ │
         │  → extractMemories, autoDream (fire-and-forget)          │ │
         │  → shell/JS hook scripts (blocking)                      │ │
         └─────────────────────────────────────────────────────────┘ │
                   │                                                  │
         ┌── DECISION ─────────────────────────────────────────────┐ │
         │  needsFollowUp = true   → transition → Continue loop ───┼─┘
         │  needsFollowUp = false  → Token budget check → Exit     │
         └─────────────────────────────────────────────────────────┘
```

---

## 2. Loop State Machine — 7 Transitions

```typescript
type Transition =
  | 'collapse_drain_retry'        // Drain staged collapses → retry
  | 'reactive_compact_retry'      // Full conversation summary → retry
  | 'max_output_tokens_escalate'  // Output cap 8K → 64K → retry
  | 'max_output_tokens_recovery'  // Multi-turn resume (max 3 lần)
  | 'stop_hook_blocking'          // Stop hook trả về blocking error
  | 'token_budget_continuation'   // Auto-continue khi budget cho phép
  | 'completed'                   // Terminal — thoát loop
```

**Loop State Object:**
```typescript
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number     // max 3
  hasAttemptedReactiveCompact: boolean     // guard: chỉ compact 1 lần
  maxOutputTokensOverride: number | undefined  // 8k → 64k
  pendingToolUseSummary: Promise<...> | undefined
  stopHookActive: boolean | undefined      // guard: không chạy lại hooks
  turnCount: number
  transition: Transition | undefined
}
```

---

## 3. Agentic Tool-Call Loop

### Concurrency Model

```
Tools trong 1 turn được chia thành batches tự động:

Batch 1: [BashTool A]              → non-concurrent, chạy 1 mình
Batch 2: [Read B, Grep C, Glob D]  → concurrent-safe, chạy song song
Batch 3: [WriteFile E]             → non-concurrent, chạy 1 mình

Read-only tools  (Glob, Grep, Read, WebFetch) → concurrent-safe
State-modifying  (Bash, Write, Edit, MCP)     → non-concurrent
```

### Loop Flow

```
Model trả về tool_use blocks
    ↓
StreamingToolExecutor.addTool(block) — ngay khi stream đến
    ↓
processQueue() — auto-start dựa trên concurrency rules
    ↓
getRemainingResults() — collect all completed results
    ↓
Parallel: generateToolUseSummary() bằng Haiku (background)
    ↓
Tool results → messages → gọi model lại
    ↓
Lặp lại cho đến khi model trả về text thuần (stop_reason = 'end_turn')
```

---

## 4. Error Recovery — Layered System

```
Lỗi API Layer:
  429 Rate Limit      → Exponential backoff (built-in Anthropic SDK)
  529 Overloaded      → FallbackTriggeredError → switch model + retry
  401/403 Auth        → Surface trực tiếp cho user
  5xx Server          → Retry với backoff

Prompt Too Long (413 / 400 prompt_too_long):
  Step 1: contextCollapse.recoverFromOverflow()
          → Drain staged collapses
          → transition = 'collapse_drain_retry'
  Step 2: reactiveCompact.tryReactiveCompact()
          → Full conversation summary via Claude
          → transition = 'reactive_compact_retry'
  Step 3: Không recover được
          → executeStopFailureHooks()
          → return { reason: 'prompt_too_long' }

Max Output Tokens:
  Step 1: Default 8K hit + cap enabled
          → escalate to 64K
          → transition = 'max_output_tokens_escalate'
  Step 2: 64K cũng hit
          → inject recovery message: "Resume directly, no recap"
          → transition = 'max_output_tokens_recovery'
  Step 3: maxOutputTokensRecoveryCount >= 3
          → surface withheld error
          → return { reason: 'completed' }

Model Fallback (FallbackTriggeredError):
  → Clear: assistantMessages, toolResults, toolUseBlocks
  → StreamingToolExecutor.discard() + tạo mới
  → stripSignatureBlocks() (bảo vệ thinking signatures)
  → Switch sang fallback model
  → Retry toàn bộ request
  → Log: 'tengu_model_fallback_triggered'

Image / Media Size Errors:
  → reactiveCompact.stripMedia() + retry
  → Guard: hasAttemptedReactiveCompact (chỉ 1 lần)
```

---

## 5. Thinking Mode (Extended Reasoning)

### Configuration
```typescript
ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'adaptive' }   // Auto-enable dựa trên query complexity
  | { type: 'enabled' }
```

### 3 Rules bắt buộc
1. Thinking block phải có `max_thinking_length > 0`
2. Thinking block **không được** là message cuối cùng trong history
3. Thinking blocks phải **giữ nguyên toàn bộ trajectory** (không sửa đổi)

### Signature Protection
- Mỗi thinking block có model-bound cryptographic signature
- Nếu switch sang fallback model → `stripSignatureBlocks()` bắt buộc trước khi retry
- Vi phạm → 400 error: *"Thinking blocks cannot be modified"*
- Orphaned thinking blocks (partial stream → abort) được tombstone xóa

---

## 6. Streaming Architecture

```
API Stream Events:
  message_start   → reset currentMessageUsage, setup tracking
  content_delta   → accumulate text/thinking tokens, yield đến UI realtime
  content_stop    → mark block done
  message_delta   → capture stop_reason (AUTHORITATIVE source)
  message_stop    → finalize usage, this.totalUsage += currentMessageUsage

Withheld Messages (KHÔNG yield đến SDK — internal recovery only):
  - Prompt-too-long      → context recovery xử lý trước
  - Max-output-tokens    → escalation xử lý trước
  - Media size errors    → reactive compact xử lý trước

StreamingToolExecutor Pattern:
  Tool blocks được start NGAY KHI stream đến (không chờ full message)
  → Giảm latency: tool execution overlap với streaming
  getCompletedResults() → yield realtime kết quả tools đến UI
```

---

## 7. Token Counting & Cost Tracking

### Per-Turn Usage
```typescript
currentMessageUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
// Accumulated mỗi message_stop event
this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
```

### Budget System (`query/tokenBudget.ts`)
```typescript
type BudgetTracker = {
  continuationCount: number      // Số lần auto-continue
  lastDeltaTokens: number        // Để detect diminishing returns
  lastGlobalTurnTokens: number
  startedAt: number
}

// Auto-stop conditions:
getTotalCost() >= maxBudgetUsd                   → Cost ceiling
delta_tokens < 500 AND continuationCount >= 3   → Diminishing returns
→ Inject nudge: "Wrap up, you're running low on budget"

// Auto-continue conditions:
budget.remaining > 0 AND hasToolUse             → Inject continuation
→ transition = 'token_budget_continuation'
```

---

## 8. Stop Hooks System

```
Turn kết thúc → handleStopHooks() [query/stopHooks.ts]
    │
    ├── Background Tasks (fire-and-forget):
    │   ├── Job Classification (TEMPLATES feature)
    │   ├── Prompt Suggestion
    │   ├── extractMemories      ← AI writes memory files
    │   └── autoDream            ← AI consolidates memories (nếu đủ gate)
    │
    ├── Shell/JS Hook Scripts (blocking):
    │   ├── executeStopHooks()
    │   ├── yield progress messages
    │   ├── track blockingErrors
    │   └── check preventContinuation flag
    │
    ├── Teammate Hooks (multi-agent):
    │   ├── TaskCompleted hooks
    │   └── TeammateIdle hooks
    │
    └── Return:
        { blockingErrors: Message[], preventContinuation: boolean }

Back in query():
  preventContinuation = true  → exit loop
  blockingErrors              → add to messages, continue loop
  else                        → token budget check → exit
```

---

## 9. Context Building

### Layers
```
1. System Prompt (static per session):
   fetchSystemPromptParts()
   ├── defaultSystemPrompt   → tool descriptions, capabilities
   ├── customSystemPrompt    → SDK override (nếu có)
   ├── memory mechanics      → nếu hasAutoMemPathOverride()
   └── appendSystemPrompt    → extra instructions

2. User Context (prepended mỗi API call):
   prependUserContext(messagesForQuery, userContext)
   ├── claudeMd              → CLAUDE.md files từ working dirs
   ├── currentDate           → local ISO date
   └── memory files          → relevant topic files (≤5, query-time recall)

3. System Context (appended mỗi API call):
   appendSystemContext(systemPrompt, systemContext)
   ├── gitStatus             → branch, recent commits, file status
   ├── cache_breaker         → ANT debugging (BREAK_CACHE_COMMAND)
   └── session metadata

4. Memory Injection (on-demand):
   findRelevantMemories(query) → Sonnet selects ≤5 files
   → inject vào user context với freshness warnings
```

---

## 10. Abort/Cancellation

### Signal Architecture
```
QueryEngine.abortController (parent)
    │
    ├── Passed to: tool execution, API calls, streaming
    │
    ├── interrupt() → abort('interrupt')
    │   Reason: User queued new message
    │
    └── siblingAbortController (child)
        → Fires khi Bash tool lỗi
        → Kill tất cả sibling tools ngay
        → KHÔNG abort parent query
```

### Tool Behavior on Abort
```typescript
interruptBehavior(): 'cancel' | 'block'
  'cancel' → abortable (Bash, WebFetch, WebSearch)
  'block'  → chờ hoàn thành (Write, Edit — data integrity)
```

### Abort Recovery
```
Aborted during streaming:
  → yieldMissingToolResultBlocks()  (synthetic errors cho queued tools)
  → executePostSamplingHooks()       (đã fire, skip)
  → Skip stop hooks
  → Return { reason: 'aborted_streaming' }

Aborted during tool execution:
  → Similar + MCP cleanup
  → StreamingToolExecutor cancelled results

Aborted during stop hooks:
  → yield createUserInterruptionMessage()
  → return { preventContinuation: true }
```

---

## 11. Instance State

```typescript
// QueryEngine instance — tồn tại suốt conversation
private mutableMessages: Message[]              // Full conversation history
private abortController: AbortController        // Owned abort signal
private permissionDenials: SDKPermissionDenial[]// Accumulated denials (yielded cuối)
private totalUsage: NonNullableUsage            // Token usage accumulated
private hasHandledOrphanedPermission: boolean   // One-time flag
private readFileState: FileStateCache           // File read cache
private discoveredSkillNames: Set<string>       // Turn-scoped
private loadedNestedMemoryPaths: Set<string>    // Loaded memory paths
```

---

## 12. Permission System

```
wrappedCanUseTool() — wrapper around canUseTool()
    │
    ├── canUseTool(tool, input, toolUseContext, ...)
    │   → Result: { behavior: 'allow' | 'deny' | 'prompt' }
    │
    ├── behavior = 'allow'   → execute tool
    ├── behavior = 'deny'    → return error tool_result
    └── behavior = 'prompt'  → interactive (CLI only, not SDK)

Denials tracking:
  this.permissionDenials.push({ tool_name, tool_use_id, tool_input })

Final yield:
  yield { type: 'result', permission_denials: this.permissionDenials }
```

---

## 13. Service Interactions

```
QueryEngine ──calls──► queryModelWithStreaming()    → Anthropic API
           ──calls──► StreamingToolExecutor         → Tool execution
           ──calls──► autoCompactIfNeeded()         → services/compact/
           ──calls──► reactiveCompact               → services/compact/reactiveCompact
           ──calls──► contextCollapse               → services/contextCollapse/
           ──calls──► recordTranscript()            → utils/sessionStorage
           ──calls──► fileHistoryMakeSnapshot()     → utils/fileHistory
           ──calls──► handleStopHooks()             → query/stopHooks
           │               ├── extractMemories      (fire-and-forget)
           │               ├── autoDream            (fire-and-forget)
           │               └── shell hooks          (blocking)
           ──calls──► logEvent()                    → services/analytics/
```

### Analytics Events (20+)
| Event | Khi nào |
|---|---|
| `tengu_auto_compact_succeeded` | Compact thành công |
| `tengu_max_tokens_escalate` | 8K → 64K escalation |
| `tengu_streaming_tool_execution_used` | StreamingToolExecutor activated |
| `tengu_model_fallback_triggered` | Fallback model switch |
| `tengu_stop_hook_error` | Hook script lỗi |
| `tengu_token_budget_continuation` | Auto-continue fired |
| `tengu_reactive_compact_attempted` | Reactive compact tried |
| `tengu_context_collapse_drained` | Collapse drained |

---

## 14. Key Design Decisions

### 1. Async Generator Pattern
`submitMessage()` và `query()` đều là async generators → cho phép UI nhận events realtime (streaming text, tool execution, permissions prompts) mà không cần callback hell.

### 2. Withheld Messages
Một số error messages được **giữ lại** (không yield ngay) để recovery logic có cơ hội xử lý trước. Chỉ yield khi recovery thất bại. → Tránh user thấy lỗi trung gian.

### 3. Streaming Tool Execution Overlap
Tools bắt đầu execute ngay khi block stream đến, không chờ `message_stop`. → Giảm latency đáng kể trong multi-tool turns.

### 4. Parallel Tool Summary
`generateToolUseSummary()` (Haiku model) chạy song song với API call tiếp theo. → Zero latency overhead cho tool summaries.

### 5. Sibling Abort Controller
Khi 1 tool lỗi, chỉ kill sibling tools (không kill parent query). → Graceful partial failure thay vì abort toàn bộ turn.

### 6. Layered Recovery
4 tầng recovery (collapse → compact → escalate → multi-turn) được thử lần lượt từ ít destructive nhất đến nhiều nhất. → Maximize chances of successful completion.

---

## Kết luận

QueryEngine là **state machine phức tạp nhất** trong Claude Code:

- **Orchestration**: Điều phối model calls + tool execution + recovery trong 1 async generator
- **Streaming-first**: Yield events realtime, tools execute overlap với streaming
- **Resilient**: 4-layer error recovery, model fallback, abort với data integrity
- **Agentic**: Tool-call loops tự động, concurrent execution, signal giữa tools
- **Context-aware**: Token budget, cost ceiling, diminishing returns detection
- **Extensible**: Stop hooks cho memory, analytics, custom shell scripts

Pattern nổi bật nhất: **Withheld Message + Layered Recovery** — errors bị giữ lại để recovery layer xử lý trước, chỉ surface lên user khi mọi recovery đều thất bại.
