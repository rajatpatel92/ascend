# AI Intelligence & MCP Integration

The **Portfolio Intelligence** module combines conversational large language models (LLMs) with your private financial ledger, while the **Model Context Protocol (MCP)** server allows external AI coding agents and assistants to interact directly with Ascend.

---

## 🤖 1. In-App AI Assistant (`/ai-analysis`)

Located at `/ai-analysis`, the chat interface enables natural language analysis of your investments.

### Capabilities & Sample Prompts
* **Asset Allocation & Diversification**:
  * *"What is my total exposure to the US Technology sector across all accounts?"*
  * *"How diversified am I across defensive vs cyclical sectors?"*
* **Risk & Currency Analysis**:
  * *"What percentage of my portfolio is vulnerable to USD/CAD currency fluctuations?"*
  * *"Analyze my single-stock concentration risk compared to index funds."*
* **Strategic Rebalancing**:
  * *"Suggest a tax-efficient plan to rebalance my portfolio toward a 20% international equity target."*
* **Historical Performance & Inflation**:
  * *"Summarize my dividend yield progression over the past 2 years."*

---

## 🛡️ 2. Privacy-First Context Grounding

Ascend operates on strict data isolation principles:

```
[Local Database] ──(Anonymized Summarization)──> [In-Memory Context] ──(HTTPS)──> [LLM Provider]
 (Holdings & Ledgers)                              (Symbols, Weights, Values)        (Gemini, GPT, Claude)
```

1. **Anonymized Payload**: When a question is submitted, Ascend compiles an ephemeral snapshot containing only:
   - Security symbols and names (e.g., `VTI`, `AAPL`).
   - Percentage portfolio weights and valuations in your base currency.
   - Aggregate sector and geographic exposure.
   - Current dividend yields and top movers.
2. **Zero Sensitive Data**: Account numbers, legal names, bank logins, and authentication tokens are **never** transmitted to any LLM.
3. **Local Mode**: If the AI module is disabled globally or per-user, Ascend runs in complete local isolation. No outgoing requests to AI providers are generated.

---

## 🔌 3. Supported LLM Providers & Models

Ascend natively supports three premier frontier LLM providers (`src/lib/llm/providers.ts`):

| Provider | Default Model | Configuration Key | Notes |
| :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-flash-latest` | `GEMINI_API_KEY` | High-speed, cost-effective analysis with generous free quotas. |
| **OpenAI** | `gpt-4-turbo` | `GPT_API_KEY` | Sophisticated multi-step financial reasoning. |
| **Anthropic Claude** | `claude-3-opus-20240229` | `CLAUDE_API_KEY` | Deep qualitative analysis and portfolio commentary. |

---

## ⚙️ 4. Administration & User Preferences

### System-Wide Configuration (Admin)
Administrators configure AI credentials in **Settings > General > AI Settings**:
* **Global AI Toggle (`AI_ENABLED`)**: Master switch that activates or deactivates the AI module across the entire platform. When turned off, the AI Analysis tab is removed from the sidebar.
* **Encrypted API Key Storage**: API keys are saved in the `SystemSetting` table and encrypted in the database.
* **Automatic Rate Limit Protection**: Providers feature automatic circuit breakers and user-friendly cooldown notifications when external rate limits (HTTP 429) are encountered.

### User Model Selection
Every user can select their preferred default LLM in **Settings > General**:
* Select between **Google Gemini**, **OpenAI GPT**, or **Anthropic Claude**.
* Preference is persisted in the user profile (`User.preferredLLM`).
* Users can individually opt out of AI features (`User.aiEnabled`).

---

## 🌐 5. Model Context Protocol (MCP) Integration (`ascend-mcp`)

Ascend includes a dedicated **MCP Server** (`ascend-mcp`) enabling AI agents (e.g., Claude Desktop, Antigravity, Cursor, or autonomous homelab sentinels) to programmatically query and manage your portfolio.

```
┌───────────────────────────────┐
│       AI Agent / Client       │
│  (Claude Desktop, Antigravity)│
└───────────────┬───────────────┘
                │ JSON-RPC (stdio / SSE)
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

### Security: Programmatic API Authentication
Ascend protects programmatic endpoints using the `MCP_API_KEY` environment variable:
* Incoming requests must provide the key via the `x-api-key` HTTP header.
* Ascend validates keys using **constant-time cryptographic comparison (`safeCompare`)** in `src/lib/api-auth.ts` to defend against timing attacks.
* Authenticated MCP requests are granted programmatic `ADMIN` execution privileges.

### Tools Exposed by `ascend-mcp`

| Tool Name | Parameters | Purpose |
| :--- | :--- | :--- |
| `get_holdings` | `currency` *(optional)* | Returns a consolidated breakdown of all held assets, quantities, market prices, values, and percentage weights. |
| `get_portfolio_performance` | `currency`, `timeRange` *(optional)* | Returns total Net Worth, Day Change, All-Time Return, and annualized XIRR. |
| `get_accounts` | — | Lists all accounts across platforms, native currencies, and active statuses. |
| `get_platforms` | — | Lists all registered brokerage platforms. |
| `list_activities` | `limit`, `symbol`, `type` | Retrieves the activity ledger with optional filtering. |
| `add_activity` | `symbol`, `type`, `date`, `quantity`, `price`, `accountName`, `platformName` | Programmatically logs a new transaction in the ledger. |
| `get_market_data` | `symbol` | Fetches live market price, daily change, and metadata for a specific ticker. |

### Connecting an MCP Client (e.g., Claude Desktop)
Add the following configuration to your `claude_desktop_config.json`:

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
