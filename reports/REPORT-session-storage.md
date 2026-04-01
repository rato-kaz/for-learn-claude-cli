# Report: Session Storage — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\utils\sessionStorage.ts` + `sessionRestore.ts` + `listSessionsImpl.ts`
> Ngày: 2026-04-01

---

## Tổng quan

Session Storage là hệ thống **append-only, batched-write** lưu toàn bộ conversation history xuống disk dưới dạng JSONL. Mỗi session có một file riêng, kèm metadata được tự động re-append để đảm bảo `/resume` picker luôn đọc được thông tin mới nhất — dù file có to bao nhiêu đi nữa.

---

## 1. Storage Layout

```
~/.claude/projects/
└── {sanitized-project-path}/                 ← mỗi project 1 thư mục
    ├── {sessionId-A}.jsonl                    ← transcript chính
    ├── {sessionId-B}.jsonl
    └── {sessionId-A}/                         ← thư mục con cho subagents
        ├── subagents/
        │   ├── agent-{agentId}.jsonl
        │   ├── agent-{agentId}.meta.json
        │   └── workflows/run-12345/
        │       └── agent-*.jsonl
        └── remote-agents/
            ├── remote-agent-task-1.meta.json
            └── remote-agent-task-2.meta.json
```

### Path Resolution

```typescript
getTranscriptPath()
  → getClaudeConfigHomeDir()  // ~/.claude (hoặc CLAUDE_CONFIG_DIR env)
  → getProjectsDir()          // ~/.claude/projects/
  → getProjectDir(cwd)        // ~/.claude/projects/{sanitizePath(cwd)}
  → `{projectDir}/{sessionId}.jsonl`
```

**sanitizePath()**: Convert project path thành string an toàn cho filesystem (handle Windows drive letters, long paths).

---

## 2. JSONL Format

Mỗi dòng trong file là một JSON object. Có nhiều loại entry:

### Message Entries

```json
{
  "type": "user",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "parentUuid": "550e8400-e29b-41d4-a716-446655440001",
  "isSidechain": false,
  "sessionId": "550e8400-e29b-41d4-a716-446655440002",
  "userType": "external",
  "cwd": "/home/user/my-project",
  "version": "1.0.0",
  "gitBranch": "main",
  "timestamp": "2025-04-01T10:30:00.000Z",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "Fix the auth bug" }]
  }
}
```

### Metadata Entries (không phải message)

```json
// Custom title (user đặt tên)
{ "type": "custom-title", "sessionId": "...", "customTitle": "Fix login screen" }

// Tag để search
{ "type": "tag", "sessionId": "...", "tag": "urgent" }

// Preview text cho /resume picker
{ "type": "last-prompt", "sessionId": "...", "lastPrompt": "Fix the auth bug…" }

// Session mode
{ "type": "mode", "sessionId": "...", "mode": "coordinator" }

// GitHub PR link
{ "type": "pr-link", "sessionId": "...", "prNumber": 123, "prUrl": "https://..." }

// Worktree state
{ "type": "worktree-state", "sessionId": "...", "worktreeSession": { "originalCwd": "...", "worktreePath": "...", "worktreeBranch": "feature/new-auth" } }

// Context collapse (compaction boundary)
{ "type": "marble-origami-commit", "sessionId": "...", "collapseId": "...", "summaryUuid": "...", "firstArchivedUuid": "...", "lastArchivedUuid": "..." }

// File attribution (commit tracking)
{ "type": "attribution-snapshot", "messageId": "...", "surface": "cli", "fileStates": { "/path/file.ts": { "claudeContribution": 1234 } } }

// Content replacement (prompt cache optimization)
{ "type": "content-replacement", "sessionId": "...", "replacements": [{ "blockId": "...", "stubSize": 512 }] }
```

**Tất cả entry types:**

```typescript
type Entry =
  | TranscriptMessage           // user / assistant / attachment / system
  | SummaryMessage              // /compact output
  | CustomTitleMessage          // user-set name
  | AiTitleMessage              // AI-generated title
  | LastPromptMessage           // /resume preview
  | TaskSummaryMessage          // subagent summary
  | TagMessage                  // search tag
  | AgentNameMessage            // subagent identity
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | WorktreeStateEntry
  | ContentReplacementEntry
  | ContextCollapseCommitEntry  // compact boundary
  | ContextCollapseSnapshotEntry
```

---

## 3. Write Flow — Batched Queue

**File:** `src/utils/sessionStorage.ts` (185KB)

### Write Queue Architecture

```typescript
class Project {
  writeQueues: Map<filePath, Array<{entry, resolve}>>
  flushTimer: NodeJS.Timeout | null
  activeDrain: Promise<void> | null

  FLUSH_INTERVAL_MS = 100    // Batch writes mỗi 100ms
  MAX_CHUNK_BYTES = 100MB    // Max per write operation
}
```

### Sequence

```
message arrive
    │
    ├── shouldSkipPersistence()?  (test mode / --no-session-persistence)
    │   YES → skip, return
    │
    ├── First user/assistant message?
    │   YES → materializeSessionFile()
    │          ├── ensureCurrentSessionFile()  (tạo file nếu chưa có)
    │          ├── reAppendSessionMetadata()   (write pending metadata)
    │          └── flush pendingEntries        (flush buffered entries)
    │
    ├── enqueueWrite(filePath, entry)
    │   ├── Add to writeQueues[filePath]
    │   └── scheduleDrain() if not scheduled
    │
    └── [After 100ms]
        drainWriteQueue()
        ├── For each filePath in writeQueues:
        │   ├── Batch entries (≤ 100MB)
        │   ├── Serialize: JSON.stringify(entry) + "\n"
        │   ├── fs.appendFile(filePath, batch)
        │   └── Resolve each entry's Promise
        └── Clean up empty queues

[On session exit]
    flush()                    ← wait for all pending writes
    reAppendSessionMetadata()  ← ensure metadata in 64KB tail
```

**Tại sao batch 100ms?** Giảm số lần syscall `appendFile` trong khi vẫn đảm bảo data flush kịp thời. File permissions: `0o600` (owner read/write only).

---

## 4. Read Flow — Lite vs Full

### Lite Read (Fast Path)

```typescript
// Dùng cho /resume picker: list 1000 sessions nhanh
readSessionLite(filePath): LiteSessionFile {
  head: string  // 64KB đầu file
  tail: string  // 64KB cuối file
  mtime: number
  size: number
}

LITE_READ_BUF_SIZE = 65536  // 64KB
```

Từ head/tail, extract được:
- `customTitle` (trong tail — luôn được re-append ở cuối)
- `tag`
- `firstPrompt` (trong head — message đầu tiên)
- `lastModified`, `fileSize`

**Performance:** 1000 sessions → ~1000 `stat()` + ~20 head/tail reads (batch size 32 concurrent).

### Full Load (Resume Path)

```typescript
loadTranscriptFile(filePath) → {
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  // ... nhiều thứ khác
}
```

#### Large File Optimization

```typescript
SKIP_PRECOMPACT_THRESHOLD = 5MB

if (fileSize > 5MB):
  readTranscriptForLoad(filePath, fileSize)
  ├── Scan file tìm compact boundary (marble-origami-commit)
  ├── postBoundaryBuf: chỉ đọc entries sau boundary
  ├── scanPreBoundaryMetadata(): recover title/tag từ phần cũ
  └── Load: 150MB file → chỉ load 32MB active portion

else:
  readFile(filePath)  // đọc toàn bộ
```

### Build Conversation Chain

```
Parse JSONL → messages Map
    │
    ├── buildConversationChain()
    │   ├── Follow parentUuid links
    │   ├── Compute leaf UUIDs (latest message per branch)
    │   └── Filter orphaned messages
    │
    └── Return: Message[] (ordered, active branch only)
```

---

## 5. Session Listing (/resume)

**File:** `src/utils/listSessionsImpl.ts`

```
listSessionsImpl({ dir?, limit?, offset? })
    │
    ├── Nếu dir provided:
    │   ├── canonicalizePath(dir)
    │   ├── getWorktreePathsPortable(dir)  ← tìm tất cả git worktrees
    │   └── Scan projects/ cho matching directories
    │
    ├── Nếu không: readdir(~/.claude/projects/)
    │
    ├── gatherCandidates()
    │   └── stat() mỗi .jsonl file → { sessionId, filePath, mtime }
    │
    ├── Sort candidates (desc by mtime)
    │
    ├── Batch read (32 concurrent):
    │   ├── readSessionLite(filePath)
    │   ├── parseSessionInfoFromLite()
    │   │   ├── Filter: skip sidechain sessions (isSidechain=true)
    │   │   ├── Filter: skip metadata-only sessions (no messages)
    │   │   └── Build SessionInfo
    │   └── Dedup: latest-mtime-wins per sessionId
    │
    └── Return: SessionInfo[] (paginated)
```

### SessionInfo

```typescript
type SessionInfo = {
  sessionId: string
  summary: string          // customTitle || lastPrompt || firstPrompt
  lastModified: number     // epoch ms
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}
```

---

## 6. Session Resume Flow

```
User chọn session từ /resume picker
    │
    ├── adoptResumedSessionFile(sessionId)
    │   ├── Switch session context
    │   ├── resetSessionFilePointer()
    │   └── restoreSessionMetadata(sessionId)
    │       └── Load metadata từ file tail
    │
    ├── loadFullLog(sessionId)
    │   ├── loadTranscriptFile(filePath)
    │   ├── buildConversationChain()
    │   └── Return Message[]
    │
    └── restoreSessionStateFromLog()
        ├── Restore file history snapshots
        ├── Restore attribution snapshots
        ├── Restore context-collapse commits
        └── Restore todos từ transcript

→ Session tiếp tục, có đầy đủ context
```

### Worktree Restoration

```typescript
// Sau khi load session:
if (worktreeSession && pathExists(worktreePath)) {
  process.chdir(worktreePath)  // Switch vào worktree
}
// else: stay in original cwd
```

---

## 7. Metadata Re-append Strategy

**Vấn đề:** Lite reads chỉ đọc 64KB tail. Sau khi compact (compaction boundary), metadata có thể nằm ngoài tail window.

**Giải pháp:** Re-append metadata ở cuối file sau mỗi session exit:

```
reAppendSessionMetadata()
    ├── Read current tail (check if external SDK wrote fresher data)
    ├── Re-append (nếu có):
    │   ├── customTitle
    │   ├── tag
    │   ├── lastPrompt (always)
    │   ├── agentName, agentColor, agentSetting
    │   ├── mode (coordinator/normal)
    │   ├── worktreeState
    │   └── prLink
    └── Đảm bảo tất cả metadata trong 64KB tail window

External SDK safety:
    ├── CLI reads tail trước khi re-append
    ├── Nếu SDK đã write fresher title → preserve it
    └── Tránh overwrite với stale data
```

---

## 8. Subagent Sessions

```
Parent session: projects/d-my-project/{mainSessionId}.jsonl

Subagent sessions (sidechains):
  projects/d-my-project/{mainSessionId}/subagents/
    ├── agent-{agentId}.jsonl            ← transcript riêng
    └── agent-{agentId}.meta.json
        {
          "agentType": "code-review",
          "worktreePath": "/path/to/worktree",
          "description": "Review authentication changes"
        }

Remote agents (CCR v2 bridge):
  projects/d-my-project/{mainSessionId}/remote-agents/
    └── remote-agent-task-1.meta.json
        {
          "taskId": "task-uuid",
          "remoteTaskType": "code-review",
          "sessionId": "ccr-session-id",
          "title": "Review PR changes",
          "spawnedAt": 1698765432000,
          "isLongRunning": false
        }
```

Subagent sessions có `isSidechain: true` → bị filter ra khỏi `/resume` list (không hiện lên để user resume trực tiếp).

---

## 9. Persistence Control

```typescript
shouldSkipPersistence(): boolean
  ├── NODE_ENV === 'test' && !TEST_ENABLE_SESSION_PERSISTENCE
  ├── cleanupPeriodDays === 0 (settings.json)
  ├── --no-session-persistence CLI flag
  └── process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
```

Khi skip: `appendEntry()` trở thành no-op, không tạo file, không ghi gì cả.

---

## 10. Edge Cases & Safety

| Tình huống | Xử lý |
|---|---|
| Corrupt JSONL line | Catch parse error, skip line, continue loading |
| File >50MB, tombstone rewrite | `MAX_TOMBSTONE_REWRITE_BYTES = 50MB` — skip full rewrite |
| Metadata ngoài 64KB tail | `reAppendSessionMetadata()` đẩy về EOF |
| Worktree bị xóa | `process.chdir()` throw → `saveWorktreeState(null)` |
| External SDK ghi fresher title | CLI đọc tail trước, preserve giá trị mới hơn |
| Session file không tồn tại | `readFile` catch → empty Map, resume hiện conversation trống |
| `appendFile` dir không tồn tại | Auto-create với `mkdir -p` |
| Progress entries trong chain | `progressBridge` map relink messages past progress entries |

---

## 11. Performance

| Operation | Cost | Ghi chú |
|---|---|---|
| List 1000 sessions (limit 20) | ~1000 stat + ~20 reads | 32 concurrent |
| Lite metadata read | ~2ms | 64KB head + tail |
| Full load (5MB) | ~100ms | Stream JSONL parse |
| Full load (150MB) | ~1s | Pre-compact skip |
| Append message | <1ms | Queued, 100ms batch |
| Flush all writes | <50ms | 100MB chunks |
| Session resume (20 messages) | ~50ms | Load + rebuild chain |

---

## 12. Files Chính

| File | Size | Trách nhiệm |
|---|---|---|
| `utils/sessionStorage.ts` | ~185KB | Project class, write queue, append logic |
| `utils/sessionRestore.ts` | ~21KB | Resume flow, state restoration |
| `utils/sessionStoragePortable.ts` | ~26KB | Lite reads, field extraction, no CLI deps |
| `utils/listSessionsImpl.ts` | ~15KB | Session listing, pagination, worktree |
| `commands/resume/resume.tsx` | — | `/resume` Ink UI, session picker |
| `types/logs.ts` | — | Entry, TranscriptMessage, SessionInfo types |
| `utils/agenticSessionSearch.ts` | — | AI-powered session search |

---

## Kết luận

Session Storage là hệ thống **append-only log** với nhiều lớp tối ưu:

1. **Batched writes** — 100ms flush window, giảm syscall không ảnh hưởng responsiveness
2. **Lite reads** — 64KB head + tail đủ để list 1000 sessions nhanh
3. **Metadata re-append** — đảm bảo metadata luôn nằm trong 64KB tail window sau compact
4. **Large file optimization** — file >5MB → chỉ load portion sau compact boundary
5. **File permissions** — `0o600`, chỉ owner đọc được
6. **Test isolation** — `shouldSkipPersistence()` prevent test sessions pollute disk
7. **Subagent organization** — transcript riêng biệt trong `subagents/` directory
8. **Worktree restoration** — persist worktree path, tự `chdir()` khi resume

Pattern đáng chú ý nhất: **Metadata re-append tại EOF** — giải quyết một cách elegant vấn đề "lite read chỉ thấy 64KB tail nhưng metadata có thể nằm ở bất kỳ đâu trong file hàng GB".
