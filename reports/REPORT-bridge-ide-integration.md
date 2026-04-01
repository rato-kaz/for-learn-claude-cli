# Report: Bridge / IDE Integration — Claude Code
> Phân tích: `d:\Claude Source Code Original\src\bridge\` + `src\cli\`
> Ngày: 2026-03-31

---

## Tổng quan

Bridge là hệ thống cho phép **IDE extensions (VS Code, JetBrains) điều khiển Claude Code CLI từ xa** qua network. Thay vì user gõ lệnh trong terminal, IDE extension gửi messages qua WebSocket/SSE, nhận kết quả streaming realtime, và hiển thị trong IDE panel.

Hệ thống có **2 phiên bản song song**: v1 (Environment-based, polling) và v2 (Direct session, không polling).

---

## 1. Kiến trúc Tổng thể

```
┌─────────────────────┐        ┌──────────────────────┐
│   IDE Extension      │        │   Anthropic Backend  │
│  (VS Code/JetBrains)│        │   (session-ingress)  │
└────────┬────────────┘        └──────────┬───────────┘
         │                                │
         │  WebSocket / SSE               │
         │◄──────────────────────────────►│
         │                                │
         │                    ┌───────────┴──────────┐
         │                    │  Claude Code CLI      │
         │                    │  (local machine)      │
         │                    │                       │
         │                    │  bridge/ + cli/        │
         │                    │  Transport layer       │
         │                    │  StructuredIO          │
         │                    └──────────────────────┘
         │
         └── OR: Direct IDE ↔ CLI via lockfile RPC
             (local IPC, không qua backend)
```

### 2 Phiên bản

| | v1 (Environment-based) | v2 (Env-less) |
|---|---|---|
| **Backend** | Environments API | Session-ingress trực tiếp |
| **Polling** | Có (500ms–5s) | Không |
| **Transport** | HybridTransport | SSETransport + CCRClient |
| **Auth** | OAuth token | Worker JWT (short-lived) |
| **Feature gate** | `tengu_ccr_bridge` | `tengu_bridge_repl_v2` |
| **Files** | `replBridge.ts` (~2400 lines) | `remoteBridgeCore.ts` |

---

## 2. Transport Layer — 3 Implementations

### HybridTransport (v1 default)
**File:** `src/cli/transports/HybridTransport.ts`

```
Reads:  WebSocket (ws:// hoặc wss://)
Writes: HTTP POST batch
```

**Tính năng đặc biệt:**
- `SerialBatchEventUploader`: batch POST writes, đảm bảo serial delivery, retry vô hạn
- Stream event delay buffer: gom content deltas trong **100ms** trước khi POST → giảm round-trips
- Backpressure: `maxQueueSize = 100,000` (fire-and-forget, không block)
- `CLOSE_GRACE_MS = 3000`: chờ drain queue trước khi đóng

```typescript
// Write flow
write(message) →
  if stream_event → buffer 100ms
  else → flush buffer + message → HTTP POST
```

**Reconnection:**
```
Base delay:   1,000ms
Max delay:   30,000ms
Sleep detect: gap > 60s → assume system slept → reset budget
Ping:         mỗi 10s
Keepalive:    mỗi 5 phút (reset proxy idle timers)

Permanent close codes (không retry):
  1002 → protocol error
  4001 → session expired / not found
  4003 → unauthorized
```

### SSETransport (v2 reads)
**File:** `src/cli/transports/SSETransport.ts`

```
Reads:  Server-Sent Events long-polling
        GET /v1/code/sessions/{id}/stream
Writes: HTTP POST (via CCRClient)
```

**SSE Frame Format:**
```
event: client_event
id: 12345
data: {"event_type": "message", "payload": {...}}

:keepalive
```

**Reconnect thông minh:**
- `Last-Event-ID` header → server replay từ `seq_num`
- Không cần full history replay
- Liveness timeout: **45 giây** silence → reconnect

**Permanent HTTP codes (không retry):** `401, 403, 404`

### WebSocketTransport (base class)
**File:** `src/cli/transports/WebSocketTransport.ts`

- Base cho HybridTransport
- CircularBuffer: 1000 messages cuối (enable replay on reconnect)
- Compatible Node.js `ws` library + browser WebSocket API (Bun)

---

## 3. Message Protocol

**File:** `src/entrypoints/sdk/controlTypes.ts`

### Data Messages (content)

```typescript
type StdoutMessage =
  | { type: 'user' }
  | { type: 'assistant' }
  | { type: 'tool_use' }
  | { type: 'tool_result' }
  | { type: 'stream_event'; event_type: string; payload: unknown }
  | { type: 'result'; subtype: string }
```

### Control Messages (protocol)

```typescript
// IDE → CLI: request
type SDKControlRequest = {
  type: 'control_request'
  request_id: string
  request: {
    subtype:
      | 'initialize'
      | 'interrupt'
      | 'set_model'
      | 'set_max_thinking_tokens'
      | 'set_permission_mode'
      | 'can_use_tool'    // ← Permission prompts
    ...
  }
}

// CLI → IDE: response
type SDKControlResponse = {
  type: 'control_response'
  response: {
    subtype: 'success' | 'error'
    request_id: string
    response?: unknown
    error?: string
  }
}
```

### Message Router (`bridgeMessaging.ts`)

```
Inbound message arrive
    │
    ├── isSDKControlResponse? → onPermissionResponse()
    │   (IDE phản hồi permission prompt)
    │
    ├── isSDKControlRequest?  → handleServerControlRequest()
    │   (server hỏi CLI làm gì đó, timeout 10-14s)
    │
    └── isSDKMessage?
        ├── Echo dedup: UUID có trong recentPostedUUIDs? → skip
        ├── Delivery dedup: UUID có trong recentInboundUUIDs? → skip
        └── type = 'user'? → onInboundMessage()
```

### Dedup Machinery — BoundedUUIDSet

```typescript
// Ring buffer với FIFO eviction
BoundedUUIDSet(capacity: number)
  .add(uuid)
  .has(uuid)

recentPostedUUIDs    // Filter echoes của own messages
recentInboundUUIDs   // Defensive dedup khi server replay

// Khi transport swap (WS → SSE):
// SSE seq-num carryover = primary fix
// UUID set = fallback
```

---

## 4. Authentication Flow

### JWT Token Refresh Scheduler
**File:** `src/bridge/jwtUtils.ts`

```typescript
createTokenRefreshScheduler({
  getAccessToken: () => oauthToken,
  onRefresh: (sessionId, newToken) => updateSessionToken(),
  refreshBufferMs: 5 * 60 * 1000  // Refresh 5 phút trước khi expire
})

// Schedule:
1. decodeJwtExpiry(token) → extract `exp` claim
2. delayMs = exp - now - 5min
3. setTimeout(doRefresh, delayMs)
4. Fallback interval: mỗi 30 phút
5. Max 3 consecutive failures → stop

// 401 on API call:
authCallback(staleToken) → refresh OAuth
Retry request với new token
If refresh fails → BridgeFatalError
```

### Trusted Device Token (v2)
**File:** `src/bridge/trustedDevice.ts`

```typescript
// CCR v2 elevated security
headers['X-Trusted-Device-Token'] = getTrustedDeviceToken()

// Server enforcement:
// enforcement_flag ON  → ConnectBridgeWorker requires trusted device
// enforcement_flag OFF → no-op, header ignored
```

---

## 5. REPL Bridge — Startup Sequence

**File:** `src/bridge/initReplBridge.ts`

```
initReplBridge()
    │
    ├── Gate 1: isBridgeEnabledBlocking()
    │   → NOT enabled → return null (log 'not_enabled')
    │
    ├── Gate 2: getBridgeAccessToken()
    │   → NO token → onStateChange('failed', '/login')
    │
    ├── Gate 3: isPolicyAllowed('bridge_access')
    │   → NOT allowed → return null (log 'policy')
    │
    └── Gate 4: Version check
        ├── v2 path: isEnvLessBridgeEnabled()
        │   → checkEnvLessBridgeMinVersion()
        │   → initEnvLessBridgeCore()
        │       POST /v1/code/sessions → session.id
        │       POST /v1/code/sessions/{id}/bridge → worker_jwt, epoch
        │       createV2ReplTransport(jwt, epoch)
        │
        └── v1 path:
            → checkBridgeMinVersion()
            → initBridgeCore()
                POST /v1/environments/bridge → envId, envSecret
                pollForWork() loop (500ms–5s)
                spawnSession() → child process
```

### Child Process Spawn

```
Child process spawned với flags:
  --sdk-url <WebSocket/SSE URL>
  --session-id <session_id>
  --session-token <JWT hoặc OAuth>
  --worker-epoch <epoch>  (v2 only)

Child process:
  → StructuredIO: read/write stdio
  → RemoteIO: forward → transport
  → Mỗi message → StdoutMessage JSON
  → Nhận control_requests → xử lý permission prompts
  → Gửi control_response → bridge relay về IDE
```

---

## 6. Permission Prompt Flow qua Bridge

```
Tool invocation (Bash, FileEdit, ...)
    ↓
checkPermissions() → behavior = 'ask'
    ↓
send control_request:
{
  type: 'control_request',
  request_id: 'req-abc',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'rm -rf /tmp/old' },
    tool_use_id: 'tu-xyz'
  }
}
    ↓
IDE hiển thị dialog cho user
    ↓
User approve / deny
    ↓
IDE gửi control_response:
{
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'req-abc',
    response: { behavior: 'allow' }
  }
}
    ↓
pendingRequests.resolve(requestId) → tool executes
```

Timeout: **10–14 giây** nếu IDE không phản hồi → fallback deny.

---

## 7. IDE Detection & Local RPC

**File:** `src/utils/ide.ts`

### Lockfile Protocol

IDE Extension viết lockfile khi khởi động:
```typescript
type LockfileJsonContent = {
  workspaceFolders?: string[]
  pid?: number
  ideName?: string
  transport?: 'ws' | 'sse'   // IDE chọn transport
  runningInWindows?: boolean
  authToken?: string          // Cho CLI → IDE RPC calls
}
```

CLI đọc lockfile → biết IDE port + auth token → gọi IDE APIs.

### DetectedIDEInfo

```typescript
type DetectedIDEInfo = {
  name: string              // 'VS Code', 'JetBrains'
  port: number
  workspaceFolders: string[]
  url: string
  isValid: boolean
  authToken?: string
  ideRunningInWindows?: boolean
}
```

### MCP Server Bridging

```
VS Code SDK: vscodeSdkMcp.ts
→ Bridge MCP servers từ IDE settings → Claude tools
→ IDE controls which MCP servers available
```

---

## 8. StructuredIO & RemoteIO

### StructuredIO (`src/cli/structuredIO.ts`)

Bidirectional SDK protocol handler:

```typescript
class StructuredIO {
  // Send:
  writeStdoutMessage(msg: StdoutMessage): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void

  // Receive:
  structuredInput: AsyncGenerator<StdinMessage | SDKMessage>

  // Request/response matching:
  pendingRequests: Map<requestId, { resolve, reject, schema }>
  handleIncomingResponse(response):
    → Match requestId
    → Validate Zod schema
    → resolve / reject promise
}
```

### RemoteIO (`src/cli/remoteIO.ts`)

Extends StructuredIO, adds transport:

```typescript
class RemoteIO extends StructuredIO {
  transport: Transport

  constructor(url, headers, refreshHeaders) {
    → getTransportForUrl(url)  // WebSocket or SSE
    → setOnData: write to structuredInput
    → setOnClose: graceful shutdown
  }

  // Token refresh on reconnect:
  refreshHeaders: () => ({ Authorization: `Bearer ${freshToken}` })
}
```

---

## 9. CCR v2 State Reporting

Chỉ v2 (SSETransport + CCRClient) có state reporting:

```typescript
reportState(state: SessionState): Promise<void>
  → PUT /worker/state { requires_action: boolean }
  → Backend hiển thị "waiting for input" indicator

reportMetadata(metadata): Promise<void>
  → PUT /worker/external_metadata

reportDelivery(eventId, status: 'processing' | 'processed'): Promise<void>
  → POST /worker/events/{id}/delivery
```

---

## 10. Feature Gates & Config

### Feature Flags

```typescript
// Build-time:
feature('BRIDGE_MODE')           // Compile-time on/off

// Runtime GrowthBook:
tengu_ccr_bridge                 // Global on/off Remote Control
tengu_bridge_repl_v2             // Enable v2 env-less path
tengu_bridge_repl_v2_config.min_version  // Minimum CLI version cho v2
tengu_bridge_min_version         // Minimum CLI version cho v1
tengu_bridge_repl_v2_cse_shim_enabled   // Session ID retag shim
```

### isBridgeEnabled() Logic

```typescript
isBridgeEnabled() =
  feature('BRIDGE_MODE')         // Compile-time
  && isClaudeAISubscriber()      // Phải là subscriber
  && getFeatureValue('tengu_ccr_bridge', false)  // GrowthBook
```

### Dev Overrides (ANT-only)

```
CLAUDE_BRIDGE_OAUTH_TOKEN  → Override OAuth token
CLAUDE_BRIDGE_BASE_URL     → Override API base URL
```

---

## 11. Session Lifecycle

```
1. INIT
   → initReplBridge() — check gates
   → Choose v1 or v2 path

2. REGISTER
   v1: POST /v1/environments/bridge → envId, envSecret
   v2: POST /v1/code/sessions → sessionId
       POST /v1/code/sessions/{id}/bridge → workerJwt, epoch

3. CONNECT
   v1: HybridTransport (WS + HTTP POST)
   v2: SSETransport (SSE) + CCRClient (HTTP POST)

4. POLL / STREAM
   v1: pollForWork() mỗi 500ms–5s
   v2: SSE stream (persistent)

5. SPAWN SESSION (khi có work)
   → Child process với --sdk-url, --session-id, --session-token

6. STREAM RESULTS
   → StdoutMessage JSON → transport → IDE

7. HANDLE PERMISSIONS
   → control_request ↔ control_response với IDE

8. COMPLETE
   → archiveBridgeSession()
   → deregisterEnvironment() (v1 only)
   → Transport cleanup
```

---

## 12. Files Chính

| File | Trách nhiệm |
|---|---|
| `bridge/initReplBridge.ts` | Entry point, gate checks, version routing |
| `bridge/replBridge.ts` | v1 core (~2400 lines), env lifecycle, polling |
| `bridge/remoteBridgeCore.ts` | v2 core, direct session, SSE |
| `bridge/bridgeMessaging.ts` | Message router, echo/dedup |
| `bridge/jwtUtils.ts` | JWT refresh scheduler |
| `bridge/trustedDevice.ts` | Trusted device token |
| `bridge/createSession.ts` | Session CRUD API |
| `bridge/bridgeConfig.ts` | Token + URL resolution |
| `cli/structuredIO.ts` | SDK protocol handler |
| `cli/remoteIO.ts` | Transport-backed StructuredIO |
| `cli/transports/HybridTransport.ts` | WS reads + HTTP POST writes |
| `cli/transports/SSETransport.ts` | SSE reads |
| `cli/transports/WebSocketTransport.ts` | WS base class |
| `utils/ide.ts` | IDE detection, lockfile, RPC |
| `services/mcp/vscodeSdkMcp.ts` | MCP bridge to VS Code SDK |

---

## Kết luận

Bridge/IDE Integration là hệ thống **remote control phức tạp** với:

1. **Dual-version architecture** — v1 (poll-based) chạy song song v2 (event-driven)
2. **Hybrid transport** — WS reads + HTTP POST writes → tối ưu latency + reliability
3. **Proactive JWT refresh** — 5 phút trước expiry, không để token expire mid-session
4. **Smart reconnect** — sleep detection, SSE seq-num carryover, UUID-based dedup
5. **Permission handshake** — control_request/response cho per-tool prompts qua IDE
6. **Lockfile IPC** — IDE ↔ CLI local RPC không qua backend
7. **State reporting** (v2) — "waiting for input" indicator trong IDE

Pattern đáng chú ý nhất: **HybridTransport write buffering** — gom content streaming deltas trong 100ms window trước khi POST, giảm đáng kể số HTTP requests mà không tăng perceived latency.
