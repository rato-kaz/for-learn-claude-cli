# Report: Context Building — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\context\` + `src\entrypoints\`
> Ngày: 2026-04-01

---

## Tổng quan

Context Building là hệ thống **lắp ráp toàn bộ context** gửi lên API mỗi lần Claude được gọi. Đây là nơi mọi thứ hội tụ: system prompt, CLAUDE.md files, git status, memory, attachments, MCP server context — tất cả được gom thành một message array tối ưu với prompt cache.

---

## 1. Kiến trúc 3 Layers

```
┌─────────────────────────────────────────────────────┐
│               Final Message Array                    │
├──────────────────────────────────────────────────────┤
│  Layer 1: System Prompt                              │
│    ├── Static core (cached globally)                 │
│    │     identity, capabilities, tool descriptions   │
│    └── Dynamic registry                              │
│          injected per-query: memory, git, CLAUDE.md  │
├──────────────────────────────────────────────────────┤
│  Layer 2: User Context                               │
│    ├── claudeMd (project instructions)               │
│    └── currentDate                                   │
├──────────────────────────────────────────────────────┤
│  Layer 3: System Context                             │
│    ├── gitStatus snapshot                            │
│    └── cacheBreaker (for dynamic refresh)            │
└──────────────────────────────────────────────────────┘
```

---

## 2. System Prompt — Static vs Dynamic

### Static Core
**Cached globally** — không đổi giữa các queries trong cùng một session:

```typescript
// Nội dung static (build-time constant):
- Identity: "You are Claude Code, Anthropic's official CLI for Claude"
- Capabilities overview
- Tool descriptions (schema JSON)
- Coding standards built into prompt
- Safety guidelines
```

### Dynamic Registry — SYSTEM_PROMPT_DYNAMIC_BOUNDARY

```
[Static portion — globally cached]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ← SYSTEM_PROMPT_DYNAMIC_BOUNDARY
[Dynamic portion — injected per-query]
  • Memory files (từ recall step)
  • Current date
  • Environment info (OS, shell, working dir)
  • IDE detection result
  • Feature flags
```

Boundary này là key cho **prompt cache optimization** — nội dung trước boundary được cache, sau boundary thay đổi mỗi turn.

---

## 3. CLAUDE.md Discovery — 4-Level Hierarchy

**File:** `src/context/claudeMd.ts`

```
Discovery order (later overrides earlier):

1. MANAGED (Anthropic-controlled)
   ~/.claude/CLAUDE.md
   (user-level global rules)

2. USER (user home dir)
   ~/.claude/CLAUDE.md  ← same location
   (or XDG_CONFIG_HOME)

3. PROJECT (git root + parents)
   Walk up from cwd → find CLAUDE.md
   Multiple files: outer → inner
   (e.g. monorepo root + subpackage)

4. LOCAL (current directory)
   ./CLAUDE.md
   (workspace-specific overrides)
```

### @include Directive

CLAUDE.md files có thể reference files khác:

```markdown
# In CLAUDE.md:
@.claude/docs/technical-preferences.md
@.claude/rules/database-code.md
```

```typescript
// Resolution logic:
resolveAtIncludes(claudeMdContent, baseDir)
  → parse "@path" lines
  → resolve relative to claudeMd location
  → inline file content
  → recursive (nested @includes supported)
  → cycle detection: Set<resolvedPaths>
```

**Giới hạn:** Max depth được kiểm soát bởi cycle detection, không bởi explicit depth limit.

---

## 4. Attachments System — 20+ Types

**File:** `src/context/attachments.ts`

Attachments là **per-turn dynamic injections** — không cố định trong system prompt, mà được inject vào từng message tùy context.

### Attachment Types

```typescript
type AttachmentType =
  // File content
  | 'file_content'          // text file đọc được
  | 'image'                 // PNG/JPG/GIF/WebP
  | 'pdf'                   // PDF (pages param)
  | 'notebook'              // Jupyter .ipynb

  // Code context
  | 'ide_selection'         // Highlighted text từ IDE
  | 'diagnostics'           // LSP errors/warnings
  | 'git_diff'              // unstaged changes
  | 'git_blame'             // line history

  // Tool results
  | 'tool_result'           // Output từ tool execution
  | 'bash_output'           // Terminal output
  | 'web_content'           // Fetched webpage

  // Memory
  | 'memory_files'          // Recalled .md files
  | 'memory_index'          // MEMORY.md content

  // Project context
  | 'claude_md'             // CLAUDE.md merged content
  | 'directory_tree'        // File structure
  | 'git_status'            // Working tree status

  // MCP
  | 'mcp_resource'          // MCP server resource
  | 'mcp_prompt'            // MCP prompt template

  // Session
  | 'conversation_summary'  // /compact output
  | 'current_date'          // ISO date string
```

### Injection Point

```typescript
// submitMessage() flow:
1. Collect user message text
2. resolveAttachments(pendingAttachments)
   → Đọc file content
   → Fetch URLs
   → Recall memory files
3. Build user turn:
   [
     { type: 'text', text: userMessage },
     ...attachments.map(toContentBlock)
   ]
4. Append to messages array
```

---

## 5. File State Cache

**File:** `src/context/fileStateCache.ts`

```typescript
FileStateCache:
  type: LRU cache
  maxSize: 25MB total
  eviction: LRU (Least Recently Used)

Entry:
  content: string
  lineCount: number
  isPartialView: boolean  ← true nếu file bị truncate
  readAt: timestamp
  hash: string            ← SHA-256 để detect staleness
```

**isPartialView flag:**
```
File > maxResultSizeChars → đọc partial
→ isPartialView = true
→ Tool result: "[Partial view: lines 1-500 of 2000]"
→ Claude biết context không đầy đủ
```

**Cache invalidation:**
```
hash(current_content) !== hash(cached_content)
→ evict + re-read
```

---

## 6. Git Context Injection

**File:** `src/context/gitContext.ts`

```typescript
// Injected vào system context mỗi session start:
gitStatus = {
  branch: string              // current branch
  mainBranch: string          // detected main/master
  status: string              // git status output
  recentCommits: string       // git log --oneline -5
}

// Format trong prompt:
`gitStatus: This is the git status at the start of the conversation.
Note that this status is a snapshot in time, and will not update during the conversation.
Current branch: ${branch}

Main branch (you will usually use this for PRs): ${mainBranch}

Status:
${status}

Recent commits:
${recentCommits}`
```

**Quan trọng:** Git status là **snapshot** — không update real-time trong session. Claude được thông báo điều này qua prompt text.

---

## 7. Cache Optimization Strategy

### Prompt Cache Architecture

```
Message 1 (system):  [STATIC — globally cached across users]
  ├── Identity + capabilities
  ├── Tool schemas
  └── Built-in rules

Message 2 (user):    [SESSION-cached — same session only]
  ├── CLAUDE.md content
  ├── Current date
  └── Environment info

Message 3+ (turns):  [NOT cached — changes every turn]
  ├── Conversation history
  └── Tool results
```

### Cache Key Construction

```typescript
// Cache hit requires byte-identical prefix
// → Sort tool list deterministically
// → Normalize CLAUDE.md whitespace
// → Stable JSON serialization (sorted keys)
```

### MCP Context: 2 Injection Strategies

```
Strategy A: System prompt injection (stable MCP resources)
  → MCP resource content → system prompt
  → Cached between turns if content unchanged

Strategy B: Attachment injection (dynamic MCP resources)
  → MCP resource → attachment per turn
  → Not cached, always fresh
  → Used when resource changes frequently
```

---

## 8. Full Flow: submitMessage() → API Call

```
submitMessage(userText, attachments)
    │
    ├── 1. Resolve pending attachments
    │      readFile(paths) → file content blocks
    │      recallMemory(query) → memory file contents
    │      fetchUrl(urls) → web content
    │
    ├── 2. Build user turn
    │      [{ type: 'text', text: userText },
    │       ...attachmentBlocks]
    │
    ├── 3. Append to conversation history
    │
    ├── 4. buildSystemPrompt()
    │      ├── staticCore (cached)
    │      ├── SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    │      ├── memoryIndex (MEMORY.md content)
    │      ├── recalledMemoryFiles
    │      ├── claudeMdContent (merged, @includes resolved)
    │      ├── currentDate
    │      └── environmentInfo
    │
    ├── 5. buildContextMessages()
    │      ├── gitStatus block
    │      └── cacheBreaker (UUID, forces cache miss when needed)
    │
    └── 6. Call API:
           messages: [
             { role: 'user', content: systemPrompt },     ← Layer 1
             { role: 'user', content: claudeMd + date },  ← Layer 2
             { role: 'user', content: gitStatus },         ← Layer 3
             ...conversationHistory,                       ← History
             { role: 'user', content: userTurn }           ← Current
           ]
```

---

## 9. Special Context Features

### IDE Selection Injection

```typescript
// Khi user highlight code trong VS Code/JetBrains:
ideSelection = {
  content: string           // highlighted text
  fileName: string
  startLine: number
  endLine: number
}

// Injected vào user turn với tag:
`<ide_selection>
${content}
</ide_selection>`
```

### Diagnostics Context

```typescript
// LSP diagnostics từ IDE (errors, warnings):
diagnostics = [{
  severity: 'error' | 'warning' | 'info'
  message: string
  file: string
  line: number
  source: string  // e.g. 'typescript', 'eslint'
}]
```

### cacheBreaker Mechanism

```typescript
// Force context refresh khi cần:
cacheBreaker = UUID.v4()  // random mỗi lần cần bust cache

// Khi nào dùng:
- Memory files thay đổi (extractMemories vừa chạy)
- CLAUDE.md reload (file changed on disk)
- Feature flag thay đổi
```

---

## 10. Context Size Management

```
Limits:
  CLAUDE.md total: không có hard limit, nhưng > 32K tokens → warning
  Memory files recalled: ≤ 5 files (query-time selection)
  MEMORY.md index: 200 dòng (line 201+ bị truncate im lặng)
  File reads: configurable maxResultSizeChars (BashTool: 30K chars)
  FileRead: Infinity (no limit — file là source-of-truth)

Overflow handling:
  Files > limit → isPartialView = true → truncation notice
  Conversation history > context window → reactive compact
  System prompt > budget → QueryEngine 4-layer recovery
```

---

## 11. Files Chính

| File | Trách nhiệm |
|---|---|
| `context/claudeMd.ts` | CLAUDE.md discovery, @include resolution, merge |
| `context/attachments.ts` | 20+ attachment types, per-turn injection |
| `context/fileStateCache.ts` | LRU file cache, 25MB limit, staleness detection |
| `context/gitContext.ts` | Git status snapshot, branch detection |
| `context/systemPrompt.ts` | Static + dynamic system prompt assembly |
| `context/memoryContext.ts` | Memory injection, MEMORY.md embed |
| `context/environmentInfo.ts` | OS, shell, CWD, IDE detection |
| `context/cacheBreaker.ts` | Cache invalidation mechanism |
| `entrypoints/sdk/contextTypes.ts` | Attachment type definitions |
| `services/mcp/mcpContext.ts` | MCP resource → context injection |

---

## Kết luận

Context Building là hệ thống **orchestration layer** — nó không tạo ra nội dung mà điều phối mọi nguồn thông tin khác:

1. **3-layer architecture** — system prompt / user context / system context với cache boundary rõ ràng
2. **CLAUDE.md hierarchy** — 4 levels (managed → user → project → local) với @include chaining
3. **Attachments system** — 20+ types, per-turn injection thay vì bake vào system prompt
4. **File state cache** — LRU 25MB, staleness detection, isPartialView flag
5. **Cache optimization** — static portion cached globally, dynamic portion per-session, cacheBreaker khi cần bust
6. **Git snapshot** — injected một lần khi session start, không update real-time
7. **MCP dual strategy** — stable resources → system prompt (cached), dynamic resources → attachments (fresh)

Pattern đáng chú ý nhất: **SYSTEM_PROMPT_DYNAMIC_BOUNDARY** tách static (cache globally) khỏi dynamic (per-session), cho phép tối ưu cost API call mà không cần sacrifice freshness của context.
