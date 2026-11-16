# MCP Integration (`ascend-mcp`)

Ascend integrates with external AI assistants and automation agents via the standalone **Model Context Protocol (MCP)** server (**`ascend-mcp`**), keeping your self-hosted Ascend web app completely free of built-in third-party LLM dependencies.

> [!NOTE]
> The legacy in-app AI chat interface (`/ai-analysis`) and built-in LLM provider settings were retired in favor of `ascend-mcp`. This ensures Ascend itself never transmits portfolio telemetry to external AI APIs while letting you connect any MCP-compatible client you choose under explicit API-key control.

---

## 🌐 1. How `ascend-mcp` Works

```
┌───────────────────────────────┐
│       AI Agent / Client       │
│  (Claude Desktop, Antigravity)│
└───────────────┬───────────────┘
                │ JSON-RPC (stdio)
                ▼
┌───────────────────────────────┐
│          ascend-mcp           │
│     (MCP Server Interface)    │
└───────────────┬───────────────┘
                │ REST API (x-api-key: MCP_API_KEY)
                ▼
┌───────────────────────────────┐
│       Ascend Application      │
│  (Next.js App / PostgreSQL)   │
└───────────────────────────────┘
```

### Security & Programmatic Authentication
* **Opt-In API Key (`MCP_API_KEY`)**: Set `MCP_API_KEY` in Ascend's `.env`. If unset, programmatic `x-api-key` authentication is disabled.
* **Timing-Safe Validation**: Incoming requests passing `x-api-key` are validated using **`crypto.timingSafeEqual`** (`safeCompare` in `src/lib/api-auth.ts`) to prevent timing side-channel attacks.
* **Auditability**: All tool actions operate over Ascend's standard RBAC-protected REST endpoints with schema validation.

---

## 🛠️ 2. Tools Exposed by `ascend-mcp`

| Tool Name | Key Parameters | Purpose |
| :--- | :--- | :--- |
| `get_holdings` | `currency` *(optional)* | Consolidated breakdown of active holdings, quantities, prices, market values, and portfolio weights. |
| `get_holdings_data` | `currency` *(optional)* | Extended holdings dataset including cost basis, gains, and constituent details. |
| `get_portfolio_performance` | `currency`, `timeRange` *(optional)* | Total Net Worth, Day Change, All-Time Return, and annualized XIRR. |
| `get_accounts` | — | Lists all configured brokerage accounts, tax types, currencies, and active status. |
| `get_platforms` | — | Lists all registered financial institutions / platforms. |
| `list_activities` | `limit`, `symbol`, `type` | Retrieves filtered ledger transactions (`BUY`, `SELL`, `DIVIDEND`, `DRIP`, etc.). |
| `add_activity` | `symbol`, `type`, `date`, `quantity`, `price`, `accountName`, `platformName` | Programmatically logs a validated transaction in the ledger. |
| `get_market_data` | `symbol` | Fetches live market price, daily change, and metadata for a ticker symbol. |

---

## 💬 3. Example Agent Workflows

With `ascend-mcp` connected to your preferred assistant, you can ask natural-language questions backed by live ledger queries:
* *"What is my current Net Worth in CAD and which positions drove today's top gains?"*
* *"List my dividend and DRIP activities for VFV.TO over the past year."*
* *"Log a BUY of 5 shares of AAPL at $225.00 in my Interactive Brokers Taxable-USD account."*

---

## 🔌 4. Connecting an MCP Client

Add `ascend-mcp` to your MCP client configuration (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ascend": {
      "command": "node",
      "args": ["/path/to/ascend-mcp/dist/index.js"],
      "env": {
        "ASCEND_API_URL": "http://localhost:3000",
        "ASCEND_API_KEY": "your_secure_mcp_api_key_here"
      }
    }
  }
}
```
