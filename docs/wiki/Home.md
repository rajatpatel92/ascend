# Welcome to the Ascend Platform Wiki

**Track, Analyze, and Optimize your investments with institutional precision.**

**Ascend** is a self-hosted, multi-currency portfolio management and financial intelligence application. It abstracts the complexity of holding heterogeneous assets (Equities, ETFs, Mutual Funds, Fixed Income, Crypto) across multiple brokerages, currencies, and tax containers into a high-performance, unified dashboard.

Whether you are a passive index investor running lifecycle glide-paths, a dividend growth investor, or an active allocator, Ascend provides mathematically rigorous return calculations (Dollar-Weighted XIRR, Time-Weighted Return NAV unitization), multi-mode FIRE retirement simulations, intelligent portfolio rebalancing, and conversational AI grounded in your private portfolio data.

---

## 🧭 Documentation Index

| Section | Description |
| :--- | :--- |
| **[Dashboard](Dashboard)** | High-level Net Worth, XIRR, Time-Weighted Return, Top Movers (impact-weighted), Dividend summary, and dual interactive charts. |
| **[Portfolio Management](Portfolio-Management)** | Platform vs Account hierarchy, multi-currency handling, activity logging, automated dividend detection & DRIP, automated stock split detection, account transfers, and bulk CSV workflows. |
| **[Portfolio Rebalancer](Portfolio-Rebalancer)** | Target asset allocations, drift calculations, exact share order recommendations, and automated lifecycle glide-path drift adjustments. |
| **[Analysis & Reports](Analysis-&-Reports)** | Multi-layer allocation drill-downs, dynamic benchmark comparisons, Net Asset Value evolution, contribution/dividend cash-flow history, and the individual **Asset Deep-Dive** page. |
| **[FIRE Calculator](FIRE-Calculator)** | Advanced retirement modeling featuring dual calculation modes (`FIXED_RATE` vs `FIXED_HORIZON`), monthly compound inflation, lifestyle analysis, and multi-decade decumulation schedules. |
| **[AI Intelligence](AI-Intelligence)** | In-app portfolio assistant powered by Google Gemini, OpenAI, or Anthropic Claude, plus Model Context Protocol (MCP) server integration (`ascend-mcp`). |
| **[Administration & Settings](Administration-&-Settings)** | User management, Role-Based Access Control (RBAC), currency conversion overrides, custom benchmarks, and master taxonomy data. |
| **[Architecture & Developer Guide](Architecture-&-Developer-Guide)** | Tech stack overview, Prisma schema data models, background cron scheduling, financial calculation engines, API reference, and development setup. |

---

## ⚡ Quick Start for Investors

Follow these four steps to start tracking your portfolio:

```
Step 1: Define Platforms ➔ Step 2: Create Accounts ➔ Step 3: Record Activities ➔ Step 4: Analyze Insights
```

1. **Create Platforms**: Navigate to **Settings > Master Data > Platforms** to register your brokerage institutions (e.g., *Interactive Brokers*, *Questrade*, *Wealthsimple*, *Zerodha*).
2. **Create Accounts**: Go to **Settings > Accounts** and create individual accounts attached to your platforms (e.g., "TFSA", "RRSP", "Taxable USD", "Demat"). Each account is designated with its native currency.
3. **Log or Import Activities**:
   - **Manual Entry**: Click **Activities** in the sidebar and use the **Add Activity** modal with live Yahoo Finance ticker search.
   - **Bulk Import**: Use the **Import CSV** tool to upload your transaction history in bulk with pre-flight schema and ticker validation.
   - **Auto-Scan Dividends**: Click **Fetch Dividends** to scan declaring companies, review ex-dividend dates, and optionally auto-reinvest (DRIP).
4. **Explore the Dashboard**: Ascend automatically unitizes your daily Net Asset Value (NAV), tracks portfolio drift against targets, computes annualized dollar-weighted returns (XIRR), and projects dividend cash flows.

---

## 🛠️ Quick Start for Developers & Self-Hosters

Ascend is built on modern web and database technologies:
- **Framework**: Next.js 16 (App Router) & React 19
- **Language**: TypeScript 5 with strict typing
- **Database**: PostgreSQL 15+ managed via Prisma ORM 5
- **Authentication**: NextAuth.js v5 with RBAC (`ADMIN`, `EDITOR`, `VIEWER`)
- **Charting**: Chart.js & Recharts
- **Market Data**: Yahoo Finance API integration with adaptive circuit-breaker throttling
- **AI / MCP**: Gemini, OpenAI, Claude, plus standalone `ascend-mcp` service

### Run with Docker Compose (Recommended)

```bash
# Clone the repository
git clone https://github.com/rajatpatel92/ascend.git && cd ascend

# Configure environment variables
cp env.example .env
# Edit .env with your preferred passwords and secrets

# Start containers
docker-compose up -d
```
Access the application at `http://localhost:3000`. Default administrator credentials: `admin` / (configured `ADMIN_PASSWORD`).

### Local Development Setup

```bash
# Install dependencies
npm install

# Run database migrations and seed system defaults
npx prisma migrate dev
npx prisma db seed

# Run unit tests
npm test

# Launch development server
npm run dev
```

For full setup instructions, data models, and API documentation, visit the **[Architecture & Developer Guide](Architecture-&-Developer-Guide)**.

---

## 🔒 Privacy & Data Ownership Principles

1. **Self-Hosted Data**: All financial data, transactions, and account identifiers remain strictly on your local PostgreSQL database.
2. **Local Mode AI**: The AI Intelligence module is opt-in. When disabled, zero outgoing HTTP requests are made to external LLM providers. When enabled, only anonymized summaries (symbols, percentage weights, values) are transmitted.
3. **API Key Security**: Third-party LLM keys and system secrets are encrypted and stored in the database.
4. **Encrypted Constant-Time Comparisons**: API keys and webhook/cron secrets are validated using timing-safe comparisons to eliminate side-channel vulnerabilities.
