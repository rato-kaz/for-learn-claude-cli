# Report: Permission System — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\utils\permissions\` + `src\hooks\toolPermission\`
> Ngày: 2026-03-31

---

## Tổng quan

Permission System của Claude Code là kiến trúc **access control đa tầng** kiểm soát mọi hành động Claude thực hiện trên máy user. Nguyên tắc cốt lõi: **deny-by-default** — tất cả tool use đều phải vượt qua pipeline permission trước khi execute.

Entry point duy nhất: `checkPermissions(context, input)` → fan-out qua 8+ decision paths.

---

## 1. 5 Permission Modes

| Mode | Mô tả | Dùng khi |
|---|---|---|
| `default` | Prompt user khi uncertain | Mọi session thông thường |
| `acceptEdits` | Auto-approve edit/write trong CWD | High-velocity dev session |
| `plan` | Block tất cả tools → Claude lập kế hoạch trước | Review trước execute |
| `bypassPermissions` | Vô hiệu hóa toàn bộ permission | Fully trusted automation |
| `auto` | ML classifier auto-approve (ANT-only) | Internal Anthropic use |

### default Mode
- Kiểm tra rules → nếu match → execute/deny
- Không match → **prompt user**
- User luôn có quyền kiểm soát cuối cùng

### acceptEdits Mode
- Auto-approve `FileEditTool`, `FileWriteTool` trong CWD
- **Block** khi vượt ra ngoài CWD
- Vẫn prompt khi delete/chmod operations

### plan Mode
```
Tool invoked → permission layer returns 'ask'
Claude thấy rejection → điều chỉnh kế hoạch
User review → approve/reject từng bước
```
Đặc biệt hữu ích: migrations, mass delete, irreversible operations.

### bypassPermissions Mode
```typescript
// Killswitch — disable vĩnh viễn:
{ "disableBypassPermissionsMode": "disable" }  // trong settings.json

// Feature gate (enterprise level):
tengu_bypass_permissions_available  // GrowthBook
shouldDisableBypassPermissions()    // Statsig per-org
```
⚠️ Cảnh báo bằng ⏵⏵ symbol trong UI.

### auto Mode (ANT-only, feature-gated)
```
feature('TRANSCRIPT_CLASSIFIER') phải bật
    ↓
ML classifier đánh giá command + context + risk
    ↓
auto-allow / auto-deny / fallback to prompt

Circuit breaker:
  maxConsecutiveDenials = 3  → fallback to manual prompt
  maxTotalDenials       = 20 → give up, always prompt
```

---

## 2. Permission Hierarchy — 4 Tầng

```
┌──────────────────────────────────────────────┐
│  1. POLICY SETTINGS (MDM / Enterprise)       │
│     allowManagedPermissionRulesOnly: true     │
│     → User rules hoàn toàn bị ignore         │
│     → UI ẩn "always allow" options           │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  2. PROJECT SETTINGS                         │
│     .claude/settings.json                    │
│     .claude/settings.local.json              │
│     → Project-scoped rules                   │
│     → Editable via /permissions command      │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  3. USER SETTINGS                            │
│     ~/.claude/settings.json                  │
│     → Global rules across tất cả projects   │
│     → Persist qua sessions                  │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│  4. SESSION GRANTS / CLI FLAGS               │
│     --allow-tool, --deny-tool                │
│     Runtime grants từ user prompts           │
│     → Temporary (không persist)             │
└──────────────────────────────────────────────┘
```

### Rule Source Types

```typescript
type PermissionRuleSource =
  | 'policySettings'   // MDM — highest priority
  | 'projectSettings'  // .claude/settings.json
  | 'localSettings'    // .claude/settings.local.json
  | 'userSettings'     // ~/.claude/settings.json
  | 'flagSettings'     // CLI overrides
  | 'cliArg'           // --allow-tool / --deny-tool
  | 'command'          // Via /permissions CLI command
  | 'session'          // Runtime in-memory grants
```

---

## 3. Rule Matching Engine

### Rule Format

```
"ToolName"              → Match toàn bộ tool
"ToolName(content)"     → Match với content cụ thể
"Bash(ls)"              → Exact match
"Bash(npm *)"           → Wildcard match (preferred)
"Bash(npm:*)"           → Prefix match (legacy)
"FileWrite(*.log)"      → Wildcard với glob
```

### Parser Engine

```typescript
// Handles escape sequences: \( và \) cho embedded parentheses
permissionRuleValueFromString('Bash(python -c "print\\(1\\)")')
→ { toolName: 'Bash', ruleContent: 'python -c "print(1)"' }
```

### Matching Strategy (3 loại)

```typescript
type ShellPermissionRule =
  | { type: 'exact',    command: string }
  | { type: 'prefix',   prefix: string }   // legacy :* syntax
  | { type: 'wildcard', pattern: string }  // new * syntax (preferred)

// Wildcard rules:
matchWildcardPattern("npm run *", "npm run build")   // ✅ true
matchWildcardPattern("npm run *", "npm install")     // ❌ false
matchWildcardPattern("python*",   "python3 script")  // ✅ true

// Multiline support: regex với 's' (dotAll) flag
// Escaped literal: \* → asterisk character
// Optional trailing space: "git *" matches bare "git" too
```

---

## 4. canUseTool — Decision Pipeline

```
Tool invocation (BashTool, FileEditTool, ...)
    │
    ├── 1. tool.checkPermissions(context, input)
    │
    ├── 2. Evaluate theo thứ tự:
    │       ├── Match allow rule?  → 'allow' (execute ngay)
    │       ├── Match deny rule?   → 'deny'  (return REJECT_MESSAGE)
    │       ├── Match ask rule?    → 'ask'   (show prompt)
    │       ├── Mode = bypass?     → 'allow'
    │       ├── Mode = plan?       → 'ask'
    │       ├── Safety check fail? → 'ask' hoặc 'deny'
    │       ├── Hook returns?      → use hook decision
    │       ├── Classifier runs?   → 'allow' / 'deny'
    │       └── Default fallback   → 'ask'
    │
    ├── 3a. behavior = 'allow'
    │       → Execute tool immediately
    │
    ├── 3b. behavior = 'deny'
    │       → Return rejection message → model thấy lỗi
    │       → recordDenial() (tracking)
    │
    └── 3c. behavior = 'ask'
            → Show PermissionRequest UI
            │
            ├── User: Allow
            │   → persistPermissionUpdates() (if checkbox)
            │   → Execute với potentially modified input
            │
            ├── User: Deny
            │   → recordDenial()
            │   → Return rejection
            │
            └── User: Abort
                → abortController.abort()
                → Hủy toàn bộ assistant message
```

### Permission Decision Reasons (9 loại)

```typescript
type PermissionDecisionReason =
  | { type: 'rule';                rule: PermissionRule }
  | { type: 'mode';                mode: PermissionMode }
  | { type: 'classifier';          classifier: string; reason: string }
  | { type: 'hook';                hookName: string; hookSource?: string }
  | { type: 'safetyCheck';         reason: string; classifierApprovable: boolean }
  | { type: 'workingDir';          reason: string }
  | { type: 'permissionPromptTool';permissionPromptToolName: string }
  | { type: 'sandboxOverride';     reason: 'excludedCommand' | 'dangerouslyDisableSandbox' }
  | { type: 'subcommandResults';   reasons: Map<string, PermissionResult> }
  | { type: 'asyncAgent';          reason: string }
  | { type: 'other';               reason: string }
```

---

## 5. BashTool Permission Pipeline

**File:** `src/tools/BashTool/bashPermissions.ts`

```
bashToolHasPermission(command, context)
    │
    ├── 1. checkPermissionMode(mode)
    │       plan mode → 'ask' ngay
    │       bypass   → 'allow' ngay
    │
    ├── 2. checkPathConstraints(command)
    │       Vượt CWD trong acceptEdits → 'ask'
    │
    ├── 3. checkSedConstraints(command)
    │       `sed -i` trên protected files → 'deny'
    │
    ├── 4. shouldUseSandbox(command)
    │       → Xác định sandbox environment
    │
    ├── 5. parseForSecurityFromAst(command)
    │       23 security checks (xem Tool System report)
    │       Protected paths: .git, .claude, ~/.ssh
    │       Shell history: ~/.bash_history
    │
    ├── 6. splitCommand_DEPRECATED(command)
    │       Split: &&, ||, ;, |
    │       → Check từng subcommand độc lập
    │       → Cap: MAX_SUBCOMMANDS = 50 (chống ReDoS)
    │       → Suggestions: ≤5 rules per prompt
    │
    ├── 7. shellRuleMatching(subcommands, rules)
    │       Match từng subcommand với allow/deny/ask rules
    │
    └── 8. Auto mode classifier (nếu available)
            → yoloClassifier.ts
```

### Dangerous Rule Stripping (Auto Mode)

Auto mode tự động strip các rules nguy hiểm khi activate:

```typescript
isDangerousBashPermission(rule):
  'Bash(*)'           → All commands — STRIPPED
  'Bash()'            → Same — STRIPPED
  'Bash(python:*)'    → Arbitrary Python — STRIPPED
  'Bash(npm run:*)'   → Script execution — STRIPPED
  'Bash(sudo *)'      → Privilege escalation — STRIPPED

isDangerousTaskPermission(rule):
  'Agent(*)'          → Sub-agent spawning — STRIPPED

ANT-only stripping:
  'Bash(git:*)'       → Potential cloud access — STRIPPED
  'Bash(aws:*)'       → Cloud exfiltration — STRIPPED
```

### Safe Environment Variables (không bị strip)

```typescript
SAFE_ENV_VARS = { 'NODE_ENV', 'PYTHON_ENV', 'SHELL', 'LANG',
                  'PATH', 'HOME', 'USER', 'PWD', 'TERM', 'TMPDIR',
                  'RUST_LOG', ... }
// Tránh false positive: "SHELL=bash bash -c ..."
```

### Blocked Shell Prefixes

```typescript
BARE_SHELL_PREFIXES = {
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash',
  'cmd', 'powershell', 'pwsh',
  'env', 'xargs',                       // Wrappers
  'nice', 'stdbuf', 'nohup', 'timeout', // Process control
  'sudo', 'doas', 'pkexec'              // Privilege escalation
}
// getSimpleCommandPrefix() → null cho các lệnh này
// → Suggest exact match thay vì wildcard nguy hiểm
```

---

## 6. Auto Mode — ML Classifier

**File:** `src/utils/permissions/yoloClassifier.ts`

### Architecture

```
Tool invocation → auto mode active?
    │
    └── isAutoModeAllowlistedTool? (FileRead, Grep, Glob, LSP)
        YES → Allow ngay (no classifier needed)
        │
        NO  → runClassifier(command, context)
              │
              ├── Stage 1: Fast model (Haiku / claude-opus-4)
              │   inconclusive? → Stage 2
              │
              └── Stage 2: Extended thinking
                  → { shouldBlock: boolean, reason: string }

Output:
  shouldBlock = false → 'allow'
  shouldBlock = true  → 'deny' hoặc 'ask' (tùy risk level)
  timeout / error     → fallback to manual prompt
```

### Classifier Configuration (GrowthBook)

```typescript
tengu_auto_mode_config = {
  enabled: boolean,
  disableFastMode: boolean,
  forceExternalPermissions: boolean
}

tengu_bash_classifier_config = {
  enabled: boolean,
  minRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
}
```

### Denial Tracking

```typescript
type DenialTrackingState = {
  consecutiveDenials: number  // Reset khi có approval
  totalDenials: number        // Không reset suốt session
}

DENIAL_LIMITS = {
  maxConsecutive: 3,   // Sau 3 liên tiếp → fallback to manual
  maxTotal: 20         // Sau 20 tổng cộng → always prompt
}
```

### Circuit Breaker

```typescript
let autoModeCircuitBroken = false
// Set khi GrowthBook disable auto mode mid-session
// Prevent silent re-entry
isAutoModeGateEnabled() → checks cached + live gate
```

---

## 7. Hook-based Permissions

### settings.json Configuration

```json
{
  "hooks": {
    "permission": [
      {
        "commands": ["Allow read from protected namespace"],
        "matcher": { "toolName": "Bash" },
        "handler": "./hooks/bashPermissionHandler.sh"
      }
    ]
  }
}
```

### Hook Handler Output

```json
{
  "behavior": "allow | deny | ask",
  "message": "Custom reason...",
  "suggestions": [
    { "type": "addRules", "destination": "projectSettings", "rules": [...] }
  ]
}
```

### Execution Pattern

```
executePermissionRequestHooks()
    ├── Race condition: First "allow" hook wins (resolveOnce)
    ├── Timeout: 5 giây per hook
    └── Error: Continue to next hook (graceful)
```

---

## 8. Permission Prompts — UI Flow

### Components
- `PermissionRequest.tsx` — Main dialog
- `FilePermissionDialog` — Specialized cho file ops
- `ToolUseConfirm` — Queue item holding user response

### User Interaction

```
Prompt mở:
    ├── Grace period: 200ms (ignore accidental keypresses)
    └── onUserInteraction() → dismiss classifier "checking..." indicator

User: Allow
    ├── validateInput()
    ├── persistPermissionUpdates() (nếu checkbox checked)
    └── Execute tool với modified input

User: Deny
    ├── recordDenial()
    └── Return PermissionDenyDecision

User: Abort
    └── abortController.abort() → hủy toàn bộ assistant message
```

### Permission Update Suggestions

```typescript
// User thấy "Yes, and always allow X" checkbox
suggestions: PermissionUpdate[]

type PermissionUpdate =
  | { type: 'addRules',     destination, rules, behavior }
  | { type: 'replaceRules', destination, rules, behavior }
  | { type: 'removeRules',  destination, rules, behavior }
  | { type: 'setMode',      destination, mode }
  | { type: 'addDirectories', destination, directories }

// Cap: MAX_SUGGESTED_RULES_FOR_COMPOUND = 5
// Compound commands ("npm install && npm run build")
// → auto-group thành 2 separate rule suggestions
```

---

## 9. Settings Schema

```typescript
export const PermissionsSchema = z.object({
  allow:                       z.array(PermissionRuleSchema).optional(),
  deny:                        z.array(PermissionRuleSchema).optional(),
  ask:                         z.array(PermissionRuleSchema).optional(),
  defaultMode:                 z.enum(PERMISSION_MODES).optional(),
  disableBypassPermissionsMode:z.enum(['disable']).optional(),
  disableAutoMode:             z.enum(['disable']).optional(),
  additionalDirectories:       z.array(z.string()).optional(),
})
```

### Ví dụ settings.json

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(npm *)",
      "FileWrite(**/*.ts)",
      "FileEdit(**/*.ts)"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(sudo *)"
    ],
    "ask": [
      "Bash(docker *)"
    ],
    "defaultMode": "default",
    "additionalDirectories": ["~/shared-workspace"]
  }
}
```

---

## 10. Mode Transitions

### Cycle (Shift+Tab)

```
default → acceptEdits → plan → bypassPermissions → auto → default
                                                         ↑
                                                  (nếu có feature gate)
```

### Context Transformations khi chuyển mode

```typescript
// Vào auto mode:
transitionPermissionMode('default', 'auto', context)
  → findDangerousClassifierPermissions()
  → Strip khỏi alwaysAllowRules
  → Lưu strippedDangerousRules để restore khi exit

// Vào plan mode:
handlePlanModeTransition()
  → Save prePlanMode context
  → Restore khi ExitPlanMode
```

---

## 11. Startup Initialization

```
Bootstrap → setupPermissionContext()
    │
    ├── loadAllPermissionRulesFromDisk()
    │   → Flatten từ tất cả enabled sources
    │   → allowManagedPermissionRulesOnly? → chỉ policy rules
    │
    ├── applyPermissionRulesToPermissionContext()
    │
    ├── shouldDisableBypassPermissions()
    │   → Statsig gate per-org
    │
    ├── verifyAutoModeGateAccess()
    │   ├── modelSupportsAutoMode(model)
    │   ├── feature flag enabled?
    │   └── strip dangerous rules nếu entering auto mode
    │
    └── Return ToolPermissionContext → AppState
```

---

## 12. Permission vs Sandbox

Hai lớp security **độc lập, bổ trợ nhau**:

```
┌───────────────────────────────────────────┐
│  PERMISSION SYSTEM (layer 1)              │
│  → Kiểm soát: Tool có được EXECUTE không  │
│  → Dựa trên: user rules / approval        │
└───────────────────────────────────────────┘
                    ↓
┌───────────────────────────────────────────┐
│  SANDBOX SYSTEM (layer 2)                 │
│  → Kiểm soát: Bash CÓ THỂ LÀM GÌ         │
│  → Restricted OS environment             │
│  → Override: dangerouslyDisableSandbox    │
└───────────────────────────────────────────┘
```

`shouldUseSandbox()` checks:
- Mode = bypassPermissions → disable sandbox
- Dangerous commands list
- CLI flags `--dangerously-disable-sandbox`

---

## 13. Analytics & Telemetry

```typescript
logEvent('tengu_tool_use_permission_decision', {
  toolName: sanitizedToolName,   // Không log full command
  decision: 'allow' | 'ask' | 'deny',
  source: { type: 'rule' | 'mode' | 'classifier' | 'hook' | ... },
  durationMs: timestamp,
  hasFeedback: boolean,
})
```

---

## 14. Legacy Compatibility

### Tool Name Aliases

```typescript
LEGACY_TOOL_NAME_ALIASES = {
  'Task':          AGENT_TOOL_NAME,       // Old "Task" → "Agent"
  'KillShell':     TASK_STOP_TOOL_NAME,
  'AgentOutputTool': TASK_OUTPUT_TOOL_NAME,
  'BashOutputTool':  TASK_OUTPUT_TOOL_NAME,
}
// Old rules auto-convert → không cần migration
```

### Prefix Syntax

```
"npm:*"  ← Old prefix syntax (backwards compat)
"npm *"  ← New wildcard (preferred)
// Parser handles both transparently
```

---

## 15. Decision Matrix

| Điều kiện | Behavior | Reason Type |
|---|---|---|
| Match allow rule | `allow` | `rule` |
| Match deny rule | `deny` | `rule` |
| Match ask rule | `ask` | `rule` |
| Mode = bypassPermissions | `allow` | `mode` |
| Mode = plan | `ask` | `mode` |
| Mode = acceptEdits, ngoài CWD | `ask` | `workingDir` |
| Safety check fail, classifier ok | `ask` + async classify | `safetyCheck` |
| Safety check fail, không classifier | `deny` | `safetyCheck` |
| Hook trả về decision | → hook result | `hook` |
| Classifier approve | `allow` | `classifier` |
| Classifier deny | `deny` | `classifier` |
| Denial tracking exceeded | `ask` | `mode` (fallback) |
| Compound command | map subcommands | `subcommandResults` |
| Default fallback | `ask` | `mode` |

---

## 16. Files Chính

| File | Trách nhiệm |
|---|---|
| `utils/permissions/permissionRuleParser.ts` | Parse rule strings, escape handling |
| `utils/permissions/shellRuleMatching.ts` | Wildcard/prefix/exact matching |
| `utils/permissions/permissionsLoader.ts` | Load rules từ tất cả sources |
| `utils/permissions/permissionSetup.ts` | Startup initialization |
| `utils/permissions/yoloClassifier.ts` | ML classifier (auto mode) |
| `utils/permissions/autoModeState.ts` | Circuit breaker state |
| `utils/permissions/denialTracking.ts` | Consecutive/total denial counters |
| `hooks/toolPermission/PermissionContext.ts` | Permission context type + merging |
| `hooks/toolPermission/canUseTool.ts` | Main decision function |
| `tools/BashTool/bashPermissions.ts` | Bash-specific pipeline (8 stages) |
| `types/permissions.ts` | All permission type definitions |
| `commands/permissions/` | `/permissions` slash command UI |

---

## Kết luận

Permission System của Claude Code là **production-grade access control** với:

1. **Hierarchical rules** — 4 tầng: policy → project → user → session
2. **5 permission modes** — từ fully interactive đến fully automated
3. **Rule matching engine** — 3 loại (exact/prefix/wildcard) với escape handling
4. **8-stage Bash pipeline** — security + path + sed + sandbox + AST + split + rules + classifier
5. **ML classifier** — auto mode với circuit breaker + denial tracking
6. **Hook-based extensibility** — shell scripts có thể inject permission decisions
7. **Defense in depth** — Permission + Sandbox = 2 independent security layers
8. **Enterprise-ready** — MDM policy override, GrowthBook feature gates, per-org control
9. **User-friendly suggestions** — Auto-generate "always allow X" rules khi approve

Threat model được design để chống: prompt injection, accidental dangerous commands, classifier manipulation, và enterprise compliance violations.
