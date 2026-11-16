# Welcome to the Ascend Platform Wiki

**Track, Analyze, and Optimize your investments with institutional precision.**

**Ascend Portfolio Manager** is a self-hosted, multi-currency portfolio management and financial analytics platform. It unifies heterogeneous assets (Equities, ETFs, Mutual Funds, Fixed Income, Crypto) across multiple brokerages, currencies, tax containers, and household owners into a crisp, high-performance dashboard.

Whether you are a passive index investor managing lifecycle glide-paths, a dividend-growth / DRIP investor, or an active household allocator, Ascend provides mathematically rigorous return metrics (Dollar-Weighted XIRR, Time-Weighted Return NAV unitization), tax-aware portfolio rebalancing, multi-mode FIRE retirement simulations with saved profiles, and Model Context Protocol (MCP) integration for external AI agents.

---

## 🧭 Documentation Index

| Section | Description |
| :--- | :--- |
| **[Dashboard](Dashboard)** | Executive Wealth Strip, Total Net Worth, All-Time Profit breakdown, XIRR, Passive Income, Unified Performance Chart, Top Movers (1D impact), Dividend summary, Live Sync Status Pill & Manual Refresh, and Sidebar Owner Net Worth Snapshots. |
| **[Portfolio Management](Portfolio-Management)** | Platform vs. Account hierarchy, multi-currency accounting, first-class `DRIP` & activity ledger, DRIP Migration Scanner, CSV import with alias mapping, automated dividend/split detection, account transfers, and Owner filtering. |
| **[Portfolio Rebalancer](Portfolio-Rebalancer)** | `Full` & `Buy-Only (+ Cash Inflow)` modes, drift tolerance bands, ticker & asset-type targets, tax-aware account routing, saved rebalance profiles, and interactive glide-step simulator. |
| **[Analysis & Reports](Analysis-&-Reports)** | Unified 5-dimension Allocation Explorer with on-demand Portfolio X-Ray (ETF look-through), benchmark comparisons, NAV evolution & contribution/dividend flows, and the **Asset Deep-Dive** page. |
| **[FIRE Calculator](FIRE-Calculator)** | Actuarial retirement modeling with `FIXED_RATE` vs. `FIXED_HORIZON` modes, monthly compound inflation, lifestyle analysis, Saved FIRE Profiles, and collapsible simulation studio. |
| **[MCP Integration (`ascend-mcp`)](AI-Intelligence)** | Standalone Model Context Protocol (MCP) server allowing external agents (Claude Desktop, Antigravity, Cursor) to query and record portfolio data via timing-safe `MCP_API_KEY` authentication. |
| **[Administration & Settings](Administration-&-Settings)** | Contextual Settings sidebar & mobile picker sheet, Obsidian Carbon dark theme, user RBAC, currency FX overrides, custom benchmarks, Market Sync Diagnostics, and master taxonomy data. |
| **[Architecture & Developer Guide](Architecture-&-Developer-Guide)** | Tech stack overview, Prisma schema models, financial calculation engines, singleflight & SWR market sync coordinator, background cron scheduling, complete REST API reference, and testing setup (`npm test`). |

---

## ⚡ Quick Start for Investors

Follow these four steps to start tracking your portfolio:

```
Step 1: Define Platforms ➔ Step 2: Create Accounts ➔ Step 3: Record Activities ➔ Step 4: Analyze Insights
```

1. **Create Platforms**: Navigate to **Settings > Master Data > Platforms** to register your brokerage institutions (e.g., *Interactive Brokers*, *Questrade*, *Wealthsimple*, *Zerodha*).
2. **Create Accounts**: Go to **Settings > Accounts** and create individual accounts attached to your platforms (e.g., `TFSA`, `RRSP`, `Taxable USD`, `Demat`), assigning each its native currency.
3. **Log, Import, or Migrate Activities**:
   - **Manual Entry**: Click **Activities** in the sidebar and use **Add Activity** with live Yahoo Finance ticker search.
   - **Bulk Import**: Use **Import CSV** to upload your brokerage export with automatic type alias mapping (e.g., `Reinvest` → `DRIP`, `DIV` → `DIVIDEND`) and pre-flight validation.
   - **Auto-Scan Dividends & Migrate DRIPs**: Click **Fetch Dividends** to scan declaring payouts or **Migrate DRIPs** to automatically pair historical `DIVIDEND` and `BUY` transactions into clean `DRIP` entries.
4. **Explore the Dashboard & Owners**: Ascend automatically unitizes daily Net Asset Value (NAV), breaks down sidebar Net Worth snapshots by household owner (`24H` to `ALL`), tracks drift against rebalance targets, and computes XIRR.

---

## 🛠️ Quick Start for Developers & Self-Hosters

Ascend is built on modern web and database technologies:
- **Framework**: Next.js 16 (App Router) & React 19
- **Language**: TypeScript 5 with strict typing
- **Database**: PostgreSQL 15+ managed via Prisma ORM 5
- **Authentication**: NextAuth.js v5 with RBAC (`ADMIN`, `EDITOR`, `VIEWER`)
- **Charting**: Chart.js 4 & Recharts 3
- **Market Data**: Yahoo Finance API integration with singleflight request coalescing, market-hours-aware SWR caching, adaptive circuit-breaker throttling, and cross-tab `BroadcastChannel` live UI convergence
- **External Agents**: Standalone `ascend-mcp` Model Context Protocol server

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

For full setup instructions, data models, and API documentation, visit the **[Architecture & Developer Guide](Architecture-&-Developer-Guide)**.
