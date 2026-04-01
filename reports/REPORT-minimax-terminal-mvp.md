# REPORT — Minimax Terminal MVP

## Mục tiêu

Tạo một công cụ AI chạy terminal dùng model riêng **Minimax M2.7**, tham khảo kiến trúc từ codebase hiện tại nhưng chạy độc lập, không phụ thuộc hoàn toàn vào stack Claude.

## Thành phần đã thêm

- `/home/runner/work/for-learn-claude-cli/for-learn-claude-cli/src/minimax-terminal-mvp/minimaxProvider.js`
  - Provider Minimax (endpoint, auth, timeout, stream/non-stream)
- `/home/runner/work/for-learn-claude-cli/for-learn-claude-cli/src/minimax-terminal-mvp/toolRuntime.js`
  - Tool runtime an toàn: `read_file`, `write_file`, `search_text`, `run_bash`
  - Giới hạn thao tác trong workspace, có confirm cho thao tác rủi ro
- `/home/runner/work/for-learn-claude-cli/for-learn-claude-cli/src/minimax-terminal-mvp/cli.js`
  - CLI chat loop, streaming output, history, slash commands cơ bản
  - Tool-call loop: model -> tool call -> execute -> gửi kết quả lại context

## Cách chạy nhanh

1. Chuẩn bị biến môi trường:

```bash
export MINIMAX_API_KEY="your_key"
export MINIMAX_MODEL="MiniMax-M2.7"
# Optional:
# export MINIMAX_BASE_URL="https://api.minimax.chat/v1"
# export MINIMAX_CHAT_ENDPOINT="https://.../chat/completions"
```

2. Chạy CLI:

```bash
node /home/runner/work/for-learn-claude-cli/for-learn-claude-cli/src/minimax-terminal-mvp/cli.js
```

3. Slash commands hỗ trợ:

- `/help`
- `/model [name]`
- `/config`
- `/workspace [absolute_path]`
- `/exit`

## Lưu ý bảo mật

- `write_file` và `run_bash` yêu cầu xác nhận trước khi thực thi.
- Đường dẫn file được kiểm tra để không thoát khỏi workspace.
- Không lưu API key vào file config của app; key đọc từ env.

## Giới hạn hiện tại (MVP)

- Mapping format tool-call của Minimax có thể cần tinh chỉnh theo payload thực tế từ tài khoản của bạn.
- Chưa có plugin/MCP/memory dài hạn/multi-agent.
- Chưa có bộ test tự động do repo hiện tại thiếu cấu hình build/test runner ở root.

