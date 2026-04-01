# Report: Lessons Learned — Sử dụng Claude Code Hiệu quả

> Đúc rút từ phân tích source code: QueryEngine, Memory System, Service Layer,
> Multi-agent Coordinator, Tool System, Permission System, Bridge/IDE Integration,
> Context Building, Skills & Plugin System, Session Storage
>
> Cập nhật: 2026-04-01 (v2 — thêm bài học 13–18)

---

## Tổng quan

Sau khi phân tích ~512K lines source code của Claude Code, dưới đây là những bài học thực tiễn giúp sử dụng Claude Code hiệu quả hơn — không phải từ documentation, mà từ cách hệ thống thực sự hoạt động bên trong.

---

## Bài học 1: Đầu tư vào Memory Files — ROI cao nhất

### Cơ chế thực tế

- `MEMORY.md` được inject vào **mọi system prompt** — Claude luôn thấy nó dù bạn không nói gì
- Query-time recall dùng Sonnet để chọn **≤5 files** dựa trên `description` trong frontmatter
- `extractMemories` forked agent chạy **sau mỗi turn** và tự quyết định gì cần lưu

### Áp dụng

- Viết `description` thật cụ thể — đây là thứ quyết định file có được đọc không:

  ```markdown
  ---
  name: Testing Rule
  description: Không mock database trong integration tests — gây incident Q3 2025
  type: feedback
  ---
  Lý do: Mock/prod divergence làm test pass nhưng migration lỗi production.
  How to apply: Mọi integration test phải hit real database.
  ```

- Giữ `MEMORY.md` **dưới 200 dòng** — dòng 201+ bị cắt im lặng, không có warning
- Dùng đúng 4 loại type:

  | Type | Khi nào dùng |
  | --- | --- |
  | `user` | Vai trò, kỹ năng, sở thích của bạn |
  | `feedback` | Quy tắc làm việc, do/don't |
  | `project` | Deadline, quyết định, context dự án |
  | `reference` | Pointer đến Linear, Grafana, Slack... |

### Tại sao quan trọng

`feedback` memories là loại có ROI cao nhất — Claude sẽ không lặp lại sai lầm cũ trong mọi session tương lai mà không cần bạn nhắc lại.

---

## Bài học 2: Nói rõ khi Claude làm Đúng lẫn Sai

### Cơ chế thực tế

`extractMemories` không phân biệt được đúng/sai nếu bạn không nói. Nó extract từ conversation pattern — nếu bạn im lặng sau khi Claude làm sai, nó có thể extract approach sai thành memory.

### Áp dụng

- Khi Claude làm **sai** → nói thẳng, có lý do:
  > *"Đừng dùng cách này vì nó gây N+1 query. Dùng eager loading thay thế."*

- Khi Claude làm **đúng** theo cách không hiển nhiên → confirm:
  > *"Đúng rồi, bundled PR là đúng trong trường hợp này. Tiếp tục theo hướng đó."*

- Cả hai đều được extract thành `feedback` memory cho session sau

---

## Bài học 3: Hiểu Token Budget — Đừng để bị gián đoạn

### Cơ chế thực tế

QueryEngine có **diminishing returns detection**:

```
delta_tokens < 500 VÀ continuationCount >= 3
→ Auto-inject nudge: "Wrap up, you're running low on budget"
```

Khi đạt cost ceiling (`maxBudgetUsd`) → Claude tự inject "wrap up" message.

### Áp dụng

- **Task lớn → chia nhỏ** thành chunks rõ ràng thay vì một prompt khổng lồ
- Nếu Claude bắt đầu "tóm tắt" giữa chừng khi chưa xong → đó là budget signal, không phải lỗi
- Dùng `/compact` **chủ động ở 60-70% context**, không chờ bị ép:

  ```
  /compact Focus on [task hiện tại] — sections 1-3 đã xong, đang làm section 4
  ```

- Dùng `/clear` giữa các task không liên quan để reset context sạch

---

## Bài học 4: Layered Recovery Hoạt động Tự động — Đừng Interrupt

### Cơ chế thực tế

Khi gặp lỗi, QueryEngine thử **4 tầng recovery** trước khi báo lỗi ra ngoài:

```
Tầng 1: Context Collapse drain      → ít destructive nhất
Tầng 2: Reactive Compact (summary)
Tầng 3: Output token escalate 8K→64K
Tầng 4: Multi-turn resume           → nhiều destructive nhất
```

Lỗi chỉ hiện ra khi **cả 4 tầng đều thất bại**.

### Áp dụng

- Nếu Claude "chậm" hoặc "im lặng" một lúc → đang chạy recovery, **không interrupt**
- Lỗi *"prompt too long"* xuất hiện = 4 tầng đều thất bại → lúc đó mới dùng `/compact`
- Lỗi *"max output tokens"* → Claude tự escalate 8K→64K rồi multi-turn resume, thường tự xử lý được

---

## Bài học 5: CLAUDE.md — Viết như Prompt, không như Documentation

### Cơ chế thực tế

`CLAUDE.md` được inject vào **mọi API call** như một phần của user context (không phải system prompt riêng). Nó được đọc mỗi turn, không chỉ đầu session.

### Áp dụng

- Viết **imperative, ngắn gọn**:

  ```markdown
  ✅ "Luôn dùng TypeScript strict mode"
  ❌ "Chúng ta sử dụng TypeScript trong project này với strict mode được bật..."
  ```

- Đặt **rule quan trọng nhất ở đầu** — token budget ảnh hưởng đến phần cuối
- **Không giải thích lý do** trong CLAUDE.md — để lý do trong memory files (tiết kiệm token)
- Dùng `@file-path` để reference file khác thay vì copy nội dung:

  ```markdown
  @.claude/docs/technical-preferences.md
  @.claude/rules/database-code.md
  ```

---

## Bài học 6: Tận dụng Multi-agent cho Task Song song

### Cơ chế thực tế

Coordinator system thiết kế theo triết lý:

> *"Parallelism is your superpower. Workers are async. Launch independent workers concurrently whenever possible."*

Async agents trả về ngay (`agentId`), chạy nền, notify qua `<task-notification>` XML khi xong.

### Áp dụng

- Thay vì tuần tự:

  ```
  Research → Fix → Test → Document
  ```

- Dùng song song:

  ```
  Agent A: Research root cause
  Agent B: Tìm test cases liên quan     ← cùng lúc
  Agent C: Đọc documentation            ← cùng lúc
  → Tổng hợp kết quả → Fix → Done
  ```

- Dùng `run_in_background: true` cho tasks độc lập nhau
- Kết quả về dần — không cần chờ tất cả xong mới tiếp tục

---

## Bài học 7: Worktree Isolation cho Mọi Thứ Rủi ro

### Cơ chế thực tế

```
isolation: 'worktree'
→ git worktree add .claude/worktrees/<agentId>
→ Agent làm việc trong bản copy hoàn toàn riêng biệt
→ Phải commit trước khi return kết quả
→ Worktree path + branch trả về trong result
```

### Áp dụng

- **Refactor lớn** → dùng worktree, xem kết quả, merge nếu ổn
- **Thử nghiệm approach không chắc** → worktree, không sợ ảnh hưởng code chính
- **Tránh situation nguy hiểm**: Claude đang sửa 5 files giữa chừng, bạn interrupt → code broken
- Sau khi worktree xong → review diff → merge thủ công hoặc tự động

---

## Bài học 8: Abort Đúng Lúc — Write/Edit Không Dừng Ngay

### Cơ chế thực tế

```typescript
interruptBehavior() = 'cancel'  // dừng ngay   (Bash, WebFetch, WebSearch)
interruptBehavior() = 'block'   // chờ xong    (Write, Edit — data integrity)
```

Sibling tools: khi 1 tool lỗi → kill sibling tools, nhưng **không kill parent query**.

### Áp dụng

- Nhấn ESC khi Claude đang **write/edit file** → nó hoàn thành file đó trước rồi mới dừng (intentional)
- Đây là tính năng, không phải bug — tránh corrupt file giữa chừng
- Muốn dừng hẳn → đợi write xong → ESC ở bước tiếp theo
- Bash tool có thể bị cancel ngay → an toàn hơn khi interrupt

---

## Bài học 9: MCP Servers — Mở rộng Tool Set đúng cách

### Cơ chế thực tế

MCP client hỗ trợ 4 transport (SSE, stdio, HTTP, WebSocket) và tự động convert MCP tools → Claude tools. Một khi kết nối, Claude dùng như native tools.

### Áp dụng

- Database (PostgreSQL, SQLite), GitHub, Linear, Slack, Grafana → đều có MCP servers
- Khai báo trong settings:

  ```json
  {
    "mcpServers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
    }
  }
  ```

- Mô tả context trong CLAUDE.md để Claude biết khi nào nên dùng MCP tool nào

---

## Bài học 10: Session Memory ≠ Persistent Memory

### Cơ chế thực tế

| | Session Memory | Persistent Memory |
| --- | --- | --- |
| Lưu ở | Context window (tạm) | `~/.claude/projects/.../memory/*.md` |
| Tồn tại | Trong session hiện tại | Qua mọi session |
| Tạo bởi | Auto (context summary) | extractMemories agent |
| Mục đích | Tiết kiệm token | Kiến thức lâu dài |

### Áp dụng

- *"Claude nhớ trong session"* ≠ *"Claude sẽ nhớ session sau"*
- Muốn Claude nhớ lâu dài → nói rõ:
  > *"Hãy lưu điều này vào memory — chúng ta dùng Railway thay vì Heroku cho project này"*
- Review memory files **định kỳ** — xóa entries lỗi thời, memories stale có freshness warning sau 1 ngày

---

## Bài học 11: Streaming Tool Execution — Tools Chạy Song song với Streaming

### Cơ chế thực tế

Tools bắt đầu execute **ngay khi block stream đến**, không chờ model trả xong message. `StreamingToolExecutor` chạy concurrent-safe tools song song.

### Áp dụng

- Claude trả lời + chạy tools **cùng lúc** → tại sao response cảm giác "nhanh"
- Nếu thấy tool results xuất hiện trong khi Claude vẫn đang stream text → đây là feature
- Đừng tạo dependencies không cần thiết giữa tasks → để tools chạy song song tự nhiên

---

## Bài học 12: Thinking Mode — Khi nào nên bật

### Cơ chế thực tế

```typescript
ThinkingConfig =
  | { type: 'disabled' }
  | { type: 'adaptive' }   // Auto-enable theo complexity
  | { type: 'enabled' }
```

Thinking blocks được **bảo vệ nghiêm ngặt** — không được modify, phải giữ nguyên trajectory.

### Áp dụng

- `adaptive` (default) — Claude tự quyết định khi nào cần think sâu
- Dùng `/effort` để tăng thinking intensity cho tasks phức tạp
- Debug / architecture decisions / complex refactor → thinking mode có lợi rõ ràng
- Simple CRUD, rename, format → thinking mode lãng phí tokens

---

## Bài học 13: CLAUDE.md Hierarchy — 4 Tầng và @include

### Cơ chế thực tế

Claude Code đọc và merge CLAUDE.md theo **thứ tự 4 tầng** (outer → inner, sau ghi đè trước):

```
1. Managed  → ~/.claude/CLAUDE.md         (Anthropic-controlled policy)
2. User     → ~/.claude/CLAUDE.md         (user home, global rules)
3. Project  → {git-root}/CLAUDE.md        (project, walk up từ cwd)
4. Local    → ./CLAUDE.md                 (current working directory)
```

`@include` directive cho phép reference file khác — được resolve relative, recursive, với cycle detection.

### Áp dụng

- Tổ chức CLAUDE.md theo tầng, không nhồi tất cả vào 1 file:

  ```
  ~/.claude/CLAUDE.md          ← global rules (luôn gõ tiếng Việt, prefer TypeScript...)
  project/CLAUDE.md            ← project rules (@include các file con)
  project/.claude/docs/        ← chi tiết từng domain (database, frontend, security...)
  ```

- Dùng `@include` để tách nội dung dài — **tiết kiệm token** vì chỉ inject những gì cần:

  ```markdown
  @.claude/docs/technical-preferences.md
  @.claude/rules/database-code.md
  ```

- Rule ở **tầng sâu hơn override** tầng ngoài — tận dụng để có per-subdirectory config trong monorepo

---

## Bài học 14: Chọn đúng Permission Mode cho từng Task

### Cơ chế thực tế

Claude Code có **5 permission modes** với mức độ tự chủ khác nhau:

```
default           → hỏi user trước mỗi tool có side effect
acceptEdits       → auto-approve file edits, hỏi các thứ khác
plan              → model thấy tool schemas nhưng KHÔNG execute được
bypassPermissions → approve tất cả (dùng trong CI/automation)
auto              → ML classifier tự quyết approve/deny
```

`auto` mode có **circuit breaker** — sau nhiều lần classifier error → fallback về `default`.

### Áp dụng

- **Explore / review code** → dùng `plan` mode: Claude có thể đọc nhưng không ghi, không chạy lệnh
- **Viết code thông thường** → `default` (hỏi từng bước, an toàn nhất)
- **Batch file edits đã review kỹ** → `acceptEdits` (không bị interrupt cho mỗi file)
- **CI pipeline / scripts automation** → `bypassPermissions` với `--allowedTools` whitelist cụ thể
- **Tránh `auto` mode** cho tasks sensitive — ML classifier có thể sai, circuit breaker chỉ là failsafe

---

## Bài học 15: Skills với `paths:` — Conditional Activation

### Cơ chế thực tế

Skills có thể khai báo `paths:` trong frontmatter — skill **chỉ xuất hiện** khi user đang làm việc với file matching glob pattern. Skills không matching được filter ra khỏi command list → giữ list gọn gàng.

Ngoài ra, Claude Code **tự động discover** skills từ nested `.claude/skills/` khi user mở/edit file (walk up directory tree).

### Áp dụng

- Tạo skills chuyên biệt theo loại file, không cần ẩn/hiện thủ công:

  ```markdown
  ---
  name: ts-refactor
  description: Refactor TypeScript code theo project conventions
  paths: ["src/**/*.ts", "tests/**/*.ts"]
  ---
  ```

- Đặt skills vào **thư mục con** của project — chúng được discover tự động:

  ```text
  project/
  └── src/
      └── .claude/skills/
          └── component-helper/
              └── SKILL.md    ← chỉ available khi làm việc trong src/
  ```

- Dùng `context: fork` trong frontmatter khi muốn skill chạy trong sub-agent riêng biệt (không ảnh hưởng conversation history chính)

---

## Bài học 16: /resume — Đặt tên Session để Tìm lại Nhanh

### Cơ chế thực tế

`/resume` picker dùng **lite read** — chỉ đọc 64KB đầu + 64KB cuối mỗi file JSONL, không load toàn bộ. Preview text trong picker là:

```
customTitle (nếu có) > lastPrompt (200 chars) > firstPrompt
```

Metadata (title, tag, last prompt) được **re-append tại EOF** sau mỗi session exit để luôn nằm trong 64KB tail window — dù file có to hàng GB đi nữa.

### Áp dụng

- **Đặt tên session ngay đầu** khi bắt đầu task dài:
  > *"Đặt tên session này là 'Fix auth bug - sprint 12'"*

- Dùng **tag** để nhóm sessions:
  > *"Tag session này là 'payment-feature'"*

- Khi resume, Claude tự load lại: file history, attribution snapshots, worktree state, context-collapse commits — **không cần setup lại từ đầu**

- Session files lưu tại `~/.claude/projects/{sanitized-project-path}/{sessionId}.jsonl` — mỗi project có thư mục riêng, không lẫn lộn giữa projects

---

## Bài học 17: BashTool — Hiểu Giới hạn An toàn

### Cơ chế thực tế

BashTool chạy **23 security checks** theo 5 lớp trước khi execute:

```
Lớp 1: Immediate kill signals      (kill -9, killall...)
Lớp 2: Dangerous rm patterns       (rm -rf /, sudo rm...)
Lớp 3: Fork bombs                  (:(){:|:&};:...)
Lớp 4: Disk wipe commands          (dd if=/dev/zero, mkfs...)
Lớp 5: Privilege escalation        (sudo su, chmod 777 /...)
```

Các lệnh bị block **ngay lập tức**, không qua permission prompt.

### Áp dụng

- Không cần lo lắng về các lệnh phá hoại — chúng bị block ở tầng code trước khi hỏi user
- Nếu Claude báo "command blocked" → đây là security layer, không phải permission issue
- Dùng `--allowedTools "Bash(npm run *)"` để whitelist chỉ các command cụ thể trong CI:

  ```bash
  claude --allowedTools "Bash(npm run *),Read,Grep" --print "Run tests"
  ```

- Bash tool có `interruptBehavior: 'cancel'` — có thể abort ngay, không như Write/Edit

---

## Bài học 18: Git Status là Snapshot — Không Phải Real-time

### Cơ chế thực tế

Git status được inject vào system context **một lần khi session bắt đầu** — không update real-time trong suốt session. Claude thậm chí được thông báo điều này trong prompt:

```
"Note that this status is a snapshot in time,
and will not update during the conversation."
```

### Áp dụng

- Nếu bạn commit/stash/checkout trong khi đang chat → Claude **không biết** trừ khi bạn báo
- Trước khi yêu cầu Claude làm gì với git (merge, rebase, tạo PR...) → nói rõ trạng thái hiện tại:
  > *"Tôi vừa commit xong, hiện đang ở branch feature/auth, cần tạo PR vào main"*
- Nếu task liên quan đến nhiều git operations → dùng `/clear` rồi bắt đầu session mới để git snapshot được refresh

---

## Priority Order — Làm gì trước

```
🥇 Đầu tư vào Memory files (feedback + project type)
    → Một lần setup, benefit vĩnh viễn

🥈 Tổ chức CLAUDE.md theo hierarchy + @include
    → Token efficient, override đúng chỗ, dễ maintain

🥉 Chia task lớn thành subtasks song song
    → Tận dụng multi-agent, giảm thời gian

4️⃣  Dùng /compact chủ động ở 60-70%
    → Tránh bị interrupt giữa task quan trọng

5️⃣  Worktree isolation cho mọi thứ rủi ro
    → Không bao giờ corrupt working code

6️⃣  Chọn đúng permission mode trước khi bắt đầu task
    → Plan mode để explore, acceptEdits để batch edit

7️⃣  Đặt tên + tag session cho task dài
    → /resume tìm lại nhanh, không mất context
```

---

## Những Điều Hay bị Hiểu Nhầm

| Hiểu nhầm | Thực tế |
| --- | --- |
| Claude "nhớ" từ session trước | Không — chỉ nhớ nếu có persistent memory files |
| ESC dừng file write ngay | Không — Write/Edit tool finish trước khi abort |
| Lỗi "prompt too long" = cần restart | Không — thử `/compact` trước, Claude có 4-layer recovery |
| Interrupt khi Claude "chậm" | Không — có thể đang chạy recovery cycle |
| CLAUDE.md chỉ đọc đầu session | Không — inject vào mọi API call |
| Multi-agent = phức tạp | Không — `run_in_background: true` là đủ để bắt đầu |
| Git status update real-time | Không — snapshot lúc session start, không tự refresh |
| BashTool hỏi permission cho mọi lệnh | Không — 23 security checks block một số lệnh ngay lập tức |
| Skills chỉ dùng cho built-in commands | Không — tạo bằng 1 file SKILL.md, discover tự động |
| /resume chỉ load messages | Không — load cả file history, worktree state, todos, attribution |

---

## Nguồn

Các bài học trên được đúc rút từ phân tích trực tiếp source code tại `d:\Claude Source Code Original\src\`:

- [REPORT-memory-system.md](REPORT-memory-system.md) — Memory architecture
- [REPORT-service-layer.md](REPORT-service-layer.md) — Service layer patterns
- [REPORT-query-engine.md](REPORT-query-engine.md) — QueryEngine internals
- [REPORT-multi-agent-coordinator.md](REPORT-multi-agent-coordinator.md) — Multi-agent system
- [REPORT-tool-system.md](REPORT-tool-system.md) — Tool execution pipeline, BashTool security
- [REPORT-permission-system.md](REPORT-permission-system.md) — Permission modes, ML classifier
- [REPORT-bridge-ide-integration.md](REPORT-bridge-ide-integration.md) — IDE bridge, transport layer
- [REPORT-context-building.md](REPORT-context-building.md) — Context layers, CLAUDE.md hierarchy
- [REPORT-skills-plugin-system.md](REPORT-skills-plugin-system.md) — Skills, plugins, dynamic discovery
- [REPORT-session-storage.md](REPORT-session-storage.md) — Session persistence, /resume internals
