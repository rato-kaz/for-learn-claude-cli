# Report: Skills & Plugin System — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\skills\` + `src\plugins\` + `src\utils\plugins\`
> Ngày: 2026-04-01

---

## Tổng quan

Skills & Plugin System là hệ thống **mở rộng Claude Code** qua custom slash commands, skill files, và plugin marketplace. User có thể tạo `/my-skill` bằng một file markdown, hoặc cài plugin từ marketplace để có bộ tools riêng. Hệ thống hỗ trợ dynamic discovery (tìm skill trong project subdirectory khi mở file), conditional activation (skill chỉ xuất hiện khi làm việc với loại file nhất định), và file watcher để hot-reload khi skill thay đổi.

---

## 1. 3 Loại Commands

**File:** `src/types/command.ts`

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)

// PromptCommand — Gửi prompt tới model (phổ biến nhất)
type PromptCommand = {
  type: 'prompt'
  getPromptForCommand(args, context): ContentBlockParam[]
  // Expands skill content → sent to Claude as user message
}

// LocalCommand — Chạy code TypeScript local, trả về text
type LocalCommand = {
  type: 'local'
  load(): Promise<LocalCommandModule>
}

// LocalJSXCommand — Render React/Ink UI trong terminal
type LocalJSXCommand = {
  type: 'local-jsx'
  load(): Promise<LocalJSXCommandModule>
}
```

### Common Properties (CommandBase)

```typescript
type CommandBase = {
  name: string
  description: string
  aliases?: string[]
  loadedFrom: 'skills' | 'commands_DEPRECATED' | 'plugin' | 'bundled' | 'mcp'
  source: 'userSettings' | 'projectSettings' | 'builtin' | 'mcp' | 'plugin' | 'bundled'

  context?: 'inline' | 'fork'   // inline=expand in current conv, fork=sub-agent
  agent?: string                 // agent type khi context='fork'

  userInvocable?: boolean        // user có thể gõ /command-name
  disableModelInvocation?: boolean  // model không được invoke

  paths?: string[]               // glob patterns cho conditional activation
  effort?: EffortValue
  hooks?: HooksSettings
}
```

---

## 2. Skill File Format (SKILL.md)

Skills được định nghĩa bằng **Markdown files với YAML frontmatter**:

```markdown
---
name: my-custom-name              # Optional: override display name
description: What this skill does # Required (hoặc auto-extracted từ heading)
when_to_use: Specific use cases
arguments: [arg1, arg2]           # Argument hints cho user
allowed-tools: [bash, read]       # Chỉ tools này được dùng trong skill
model: claude-sonnet-4-6          # Override model
user-invocable: true              # Cho phép gõ /skill-name
disable-model-invocation: false   # Model có thể invoke
effort: 3                         # Complexity estimate
paths: ["src/**/*.ts"]            # Conditional activation
context: fork                     # 'inline' (default) | 'fork'
agent: test-runner                # Agent type khi context='fork'
hooks:
  onSessionStart:
    - script: ./setup.sh
---

# Skill content — Đây là prompt gửi tới Claude

Hãy làm ${arg1} với ${arg2}.

Chạy lệnh này:
!`npm run build`
```

**Hai format cho thư mục `/skills/`:**
```
✓ skill-name/SKILL.md    (directory format — required trong /skills/)
✗ skill-name.md          (single file — chỉ hỗ trợ trong legacy /commands/)
```

---

## 3. Skill Discovery — 6 Nguồn

**File:** `src/skills/loadSkillsDir.ts` (~2000 lines)

```
Loading Order (later overrides earlier):

1. Bundled Skills        → src/skills/bundled/ (compiled vào binary)
2. Built-in Plugins      → registerBuiltinPlugin() (enable/disable by user)
3. Skill Dir Commands    → Filesystem:
   ├─ Managed            → ~/.claude/skills/ (policy-controlled)
   ├─ User               → ~/.claude/skills/ (user home)
   ├─ Project            → .claude/skills/ (git root)
   ├─ Additional         → --add-dir CLI flag paths
   └─ Legacy             → .claude/commands/ (deprecated)
4. Plugin Skills         → Từ installed plugins
5. MCP Skills            → Model Context Protocol servers
6. Dynamic Skills        → Discovered at runtime (file operations)
```

### Skill Directories Layout

```
~/.claude/
├── skills/                    # User-level skills
│   ├── build/
│   │   └── SKILL.md
│   └── deploy/
│       └── SKILL.md
├── commands/                  # Legacy (deprecated)
│   └── old-command.md
└── plugins/
    └── cache/
        └── {marketplace}/{plugin}/{version}/
            ├── plugin.json
            ├── skills/
            ├── commands/
            ├── agents/
            └── hooks/

.claude/                       # Project-level skills
└── skills/
    └── my-project-skill/
        └── SKILL.md
```

---

## 4. Skill Loading Pipeline

### getCommands() Flow

```
loadAllCommands(cwd)  [memoized by cwd]
    │
    ├── getSkills(cwd)
    │   ├── getSkillDirCommands(cwd)    [memoized]
    │   │   ├── loadSkillsFromSkillsDir(~/.claude/skills/)
    │   │   ├── loadSkillsFromSkillsDir(.claude/skills/)
    │   │   ├── loadSkillsFromCommandsDir()  [legacy]
    │   │   ├── Dedup bởi file identity (realpath — detect symlinks)
    │   │   └── Filter conditional skills (paths:) → store separately
    │   ├── getPluginSkills()
    │   ├── getBundledSkills()
    │   └── getBuiltinPluginSkillCommands()
    ├── getPluginCommands()
    └── getWorkflowCommands()
    │
    ├── getDynamicSkills()    [runtime discovered]
    ├── Filter: meetsAvailabilityRequirement()
    ├── Filter: isCommandEnabled()
    └── Dedup + sort → return
```

### Parsing SKILL.md

```typescript
// Step 1: Parse frontmatter
const { frontmatter, content } = parseFrontmatter(skillContent, filePath)

// Step 2: Extract metadata
const parsed = parseSkillFrontmatterFields(frontmatter, content, skillName)
// → { description, allowedTools, argumentHint, model, hooks, context, ... }

// Step 3: Create Command object
const command = createSkillCommand({
  skillName, description, markdownContent, baseDir,
  loadedFrom: 'skills', source: 'userSettings',
  ...parsed
})

// Step 4: On invocation — variable substitution
command.getPromptForCommand(userArgs, context) {
  return substituteArguments(markdownContent, userArgs, args)
  // "Create ${arg1}" + "build" → "Create build"
}
```

---

## 5. Skill Execution Pipeline

```
User gõ: "/my-skill arg1 arg2"
    │
    ├─ parseSlashCommand() → { commandName: "my-skill", args: "arg1 arg2" }
    │
    ├─ getCommands(cwd) + findCommand("my-skill")
    │
    ├─ if cmd.type === 'prompt':
    │   ├── getPromptForCommand("arg1 arg2", context)
    │   │   ├── Substitute ${arg1}, ${arg2}
    │   │   ├── Execute inline shell (!`npm build`)
    │   │   └── Return content blocks
    │   └── Send to Claude as user message
    │
    ├─ if cmd.type === 'local':
    │   ├── module = await cmd.load()  [lazy loaded]
    │   └── result = await module.call(args, localContext)
    │
    └─ if cmd.type === 'local-jsx':
        └── Render React/Ink UI component

Context handling:
    context === 'inline' (default)
        → Expand prompt vào current conversation
        → Claude thấy và build on conversation history

    context === 'fork'
        → Create sub-agent với isolated context
        → agentType = cmd.agent || 'general-purpose'
        → Kết quả return về parent session
```

### Inline Shell Execution trong Skills

```markdown
---
allowed-tools: [bash]
---

Kết quả build:
!`npm run build`

Và test:
!`npm test`
```

Khi execute: Claude Code tìm `!`...`` blocks → check `allowed-tools` → chạy bash → trả stdout/stderr cho model.

---

## 6. Dynamic Skills Discovery

**File:** `src/skills/loadSkillsDir.ts` + `src/utils/skills/skillChangeDetector.ts`

### Trigger: File Operation

Khi user đọc/ghi/edit file → Claude Code walk up directory tree tìm nested skill dirs:

```typescript
// Ví dụ: User mở /project/src/components/Button.tsx
discoverSkillDirsForPaths(['/project/src/components/Button.tsx'], '/project')

// Walk up từ file location:
Walk 1: /project/src/components/.claude/skills/  → không tồn tại
Walk 2: /project/src/.claude/skills/              → TÌM THẤY → load
Walk 3: /project/.claude/skills/                  → đã load lúc startup
// stop khi đến cwd level

// Bảo mật: skip gitignored directories
if (await isPathGitignored(dir, cwd)) continue
```

**Priority:** Skills từ thư mục con sâu hơn có priority cao hơn.

### Conditional Activation (paths: frontmatter)

```markdown
---
name: typescript-helper
paths: ["src/**/*.ts", "tests/**/*.ts"]
---
```

```typescript
// Stored separately, not in main commands list
conditionalSkills.set(name, skill)

// Activated khi user open/edit matching file:
activateConditionalSkillsForPaths(filePaths, cwd)
  → skillIgnore = ignore().add(skill.paths)  // gitignore-style matching
  → if skillIgnore.ignores(relativePath):
      dynamicSkills.set(name, skill)  // Activate!
```

### File Watcher (Hot-Reload)

```typescript
// src/utils/skills/skillChangeDetector.ts
// Watches ~/.claude/skills/, .claude/skills/, etc.

chokidar.watch(paths, {
  awaitWriteFinish: { stabilityThreshold: 1000 },
  depth: 2,              // skills/skill-name/SKILL.md
  usePolling: USE_POLLING,  // Dùng stat() trên Bun (deadlock workaround)
})

// On change → debounce 300ms → clearSkillCaches() → skillsChanged.emit()
```

---

## 7. Plugin System

### Plugin Architecture

```typescript
type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string                    // Filesystem path
  source: string                  // "name@marketplace"
  isBuiltin?: boolean             // Built-in vs marketplace
  commandsPath?: string
  skillsPaths?: string[]
  agentsPaths?: string[]
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, MCPServerConfig>
}
```

### Plugin Manifest (plugin.json)

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "...",
  "author": { "name": "...", "email": "..." },
  "repository": "https://github.com/...",

  "commands": "./commands",
  "skills": "./skills",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json",

  "mcpServers": {
    "my-mcp": { "command": "node", "args": ["./mcp-server.js"] }
  },

  "dependencies": ["other-plugin@marketplace"]
}
```

### Plugin Namespacing

Plugin commands có prefix để tránh collision:

```
my-plugin/skills/formatter/SKILL.md       → /my-plugin:formatter
my-plugin/skills/utils/format/SKILL.md    → /my-plugin:utils:format
my-plugin/commands/build.md               → /my-plugin:build
```

Built-in commands dùng flat naming (không có namespace).

### Plugin Loading Flow

```
loadAllPlugins()
    │
    ├── Marketplace plugins:
    │   ├── Resolve marketplace.json (từ remote repo)
    │   ├── Find plugin version
    │   ├── Download/cache to ~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
    │   ├── Load plugin.json
    │   ├── Validate schema (Zod)
    │   └── Create Command objects from markdown files
    │
    ├── Built-in plugins:
    │   ├── Get from BUILTIN_PLUGINS registry (registerBuiltinPlugin())
    │   ├── Apply user enabled/disabled settings
    │   └── Convert to LoadedPlugin objects
    │
    └── Return { enabled, disabled, errors }
```

---

## 8. Security

### Gitignore Checking

```typescript
// Dynamic skill discovery: skip gitignored dirs
// Ngăn load skills từ node_modules/.claude/skills/
if (await isPathGitignored(currentDir, cwd)) continue
```

### Bundled Skill Safe File Write

```typescript
// Khi bundled skill cần write reference files:
// ~/.claude/bundled-skills/{nonce}/{skill-name}/

const SAFE_WRITE_FLAGS =
  O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW

// Defense-in-depth:
// 1. Random nonce directory per process
// 2. O_EXCL: fail nếu file đã tồn tại
// 3. O_NOFOLLOW: không follow symlinks
// 4. 0o600: owner-only permissions
```

### Skill Tool Restrictions

```yaml
allowed-tools: [bash, read]  # Chỉ tools này
```

Override user/policy permissions trong scope của skill đó.

### Plugin Enterprise Policies

```typescript
{
  "pluginOnlyPolicy": { "skills": true },  // Chỉ plugin skills được dùng
  "knownMarketplaces": ["github:anthropics/..."],  // Whitelist
  "blockedMarketplaces": ["github:untrusted/..."]   // Blacklist
}
```

---

## 9. Caching Strategy

| Cache | Scope | Clear trigger |
|---|---|---|
| `loadAllCommands` | Per-cwd | `clearCommandMemoizationCaches()` |
| `getSkillDirCommands` | Global | `clearSkillCaches()` |
| Dynamic skills | Global | `clearDynamicSkills()` hoặc `/clear` |
| Conditional skills | Global | `clearSkillCaches()` |
| Plugin commands | Global | `clearPluginCommandCache()` |
| File watcher | Auto | File change (debounce 300ms) |

**Key patterns:**
```typescript
// Memoization by cwd
const getSkillDirCommands = memoize(async (cwd: string) => { ... })

// Lazy loading — module chỉ load khi invoked
type LocalCommand = {
  load: () => Promise<LocalCommandModule>  // không load ở startup
}

// Parallel loading — all sources concurrently
const [managed, user, project] = await Promise.all([
  loadSkillsFromSkillsDir(...),
  loadSkillsFromSkillsDir(...),
  loadSkillsFromSkillsDir(...),
])

// Dedup by realpath — detect symlinks
const fileId = await realpath(filePath)
if (seenFileIds.has(fileId)) continue
```

---

## 10. Files Chính

| File | Lines | Trách nhiệm |
|---|---|---|
| `skills/loadSkillsDir.ts` | ~2000 | Core skill discovery & loading |
| `commands.ts` | ~750 | Command orchestration, getCommands() |
| `types/command.ts` | ~217 | Command type definitions |
| `types/plugin.ts` | ~364 | Plugin type definitions |
| `utils/plugins/pluginLoader.ts` | ~1500 | Plugin discovery & loading |
| `utils/plugins/loadPluginCommands.ts` | ~500 | Extract skills từ plugins |
| `utils/plugins/schemas.ts` | ~2000 | Zod validation schemas |
| `utils/skills/skillChangeDetector.ts` | ~312 | File watcher & cache invalidation |
| `plugins/builtinPlugins.ts` | ~160 | Built-in plugin registry |
| `skills/bundledSkills.ts` | ~221 | Bundled skill registration |

---

## Kết luận

Skills & Plugin System là hệ thống **extensibility layer** với nhiều lớp tinh tế:

1. **3 execution types** — PromptCommand (→ model), LocalCommand (→ TypeScript), LocalJSXCommand (→ Ink UI)
2. **6 loading sources** — Bundled → Built-in → Filesystem → Plugin → MCP → Dynamic
3. **Dynamic discovery** — Skills được tìm từ nested `.claude/skills/` khi file operation xảy ra
4. **Conditional activation** — `paths:` frontmatter → skill chỉ xuất hiện khi làm việc với matching files
5. **Hot-reload** — chokidar watcher → skill thay đổi trên disk → tự reload, không cần restart
6. **Plugin namespacing** — `plugin-name:skill-name` tránh collision
7. **Dedup by realpath** — symlinks và overlapping paths không tạo duplicate commands
8. **Lazy loading** — LocalCommand modules chỉ load khi invoked, giảm startup time

Pattern đáng chú ý nhất: **Conditional Skills với glob patterns** — một skill có thể "invisible" trong hầu hết thời gian và chỉ xuất hiện khi user đang làm việc với loại file phù hợp, giữ cho command list gọn gàng mà không mất đi tính sẵn sàng.
