# llm-fallback-mcp

> MCP server that completes prompts with automatic provider fallback across **OpenAI**, **Anthropic Claude**, and **Google Gemini**. Built for production: rate-limit aware, retries on transient failures, transparent attempt log.

[![MIT License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blueviolet)](https://modelcontextprotocol.io)

## Why

LLM APIs go down. They rate-limit you. One provider has an outage, the others usually don't. Production LLM apps need fallback. This server gives you the pattern as a single MCP tool.

- **Try OpenAI → Anthropic → Gemini** in order (configurable)
- **Each provider retries once** on 429 / 5xx / network errors with backoff
- **Return first success** with a full per-provider attempt log
- **Skip providers without keys** automatically
- **Zero SDK dependencies** — calls each provider's REST API directly

## Install

```bash
npm install -g llm-fallback-mcp
```

Or `npx`:

```bash
npx llm-fallback-mcp
```

## Use with Claude Desktop

Add to `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llm-fallback": {
      "command": "npx",
      "args": ["-y", "llm-fallback-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "GEMINI_API_KEY": "..."
      }
    }
  }
}
```

Only set keys for providers you want active. Missing keys = provider skipped.

## Tools

### `complete`

| Arg | Type | Required | Default |
|---|---|---|---|
| `prompt` | string | yes | — |
| `chain` | string[] | no | `["openai", "anthropic", "gemini"]` |
| `model_overrides` | object | no | — |
| `temperature` | number | no | `0.5` |
| `max_tokens` | number | no | `1024` |

### `health_check`

Returns which providers are configured.

## Example response

```json
{
  "text": "...",
  "provider_used": "anthropic",
  "model_used": "claude-haiku-4-5-20251001",
  "attempts": [
    { "provider": "openai", "ok": false, "status": 429, "durationMs": 412 },
    { "provider": "anthropic", "ok": true, "durationMs": 1133 }
  ]
}
```

## Local development

```bash
git clone https://github.com/KhushalB25/llm-fallback-mcp.git
cd llm-fallback-mcp
npm install
npm run build
OPENAI_API_KEY=sk-... npm start
```

## Author

[Khushal Bhandari](https://www.khushalbhandari.everyai.in) · [GitHub](https://github.com/KhushalB25)

## License

MIT
