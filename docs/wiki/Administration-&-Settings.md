# Administration & Settings

The **Settings** module lets administrators and household members customize interface appearance, reporting currency, FX overrides, brokerage accounts, user RBAC permissions, benchmarks, and master taxonomy data.

---

## 🧭 Contextual Settings Navigation & Responsive UI

Ascend uses a streamlined **Contextual Sidebar + Single-Column Workspace** pattern (`src/lib/settings-nav.ts`):

* **Contextual Main Sidebar Swap (`Sidebar.tsx`)**: Navigating into `/settings` or `/settings/*` replaces the main app links with a **`Back to App`** button and role-filtered Settings sections (`General`, `Currency & FX`, `Accounts`, `Users`, `Master Data`). Because main links and settings links never nest side by side, both the **Owner Net Worth Snapshot** tiles and footer controls fit cleanly without crowding.
* **Mobile Section Picker Sheet**: On mobile (`<= 768px`), a compact **`Sections ▾`** button in the header opens a vertical bottom-sheet picker for 1-tap switching without horizontal pill scrolling.
* **Linear-Style Row Layout & Obsidian Carbon Theme**: Preferences render as hairline-divided key-value rows across a neutral **Obsidian Carbon** (`#09090b` canvas, `#050506` sidebar, `#121215` cards) dark palette alongside crisp light mode.

---

## ⚙️ 1. General Preferences & Benchmarks

Located at `/settings`:

### User Interface Preferences
* **Appearance**: Toggle cleanly between **Light** and **Dark (Obsidian Carbon)** modes, persisted locally (`ThemeContext`) to prevent FOUC on load.
* **Date Format (`DateContext`)**: Customize date formatting across tables, tooltips, and ledgers with live preview:
  * `MM/DD/YYYY` (US Standard)
  * `DD/MM/YYYY` (UK, Europe, India)
  * `YYYY-MM-DD` (ISO 8601)
  * `MMM DD, YYYY` (Medium Form)
* **Default Display Currency**: Select the base currency used across dashboard KPIs and charts with live numeric preview.

### Benchmark Index Configuration (`BenchmarkSettings`)
Manage indices selectable inside **Analysis > Comparison**:
* **System Benchmarks**: Pre-seeded indices including S&P 500 (`^GSPC`) and Nasdaq 100 (`^IXIC`).
* **Custom Benchmarks**: Add any Yahoo Finance index or ETF (e.g., TSX Composite `^GSPTSE`, `VTI`, `VT`). Stored in the `Benchmark` table and refreshed by market-data syncs.

---

## 💱 2. Currency & FX

Located at `/settings/currency`:

Ascend supports 11 major currencies (`USD`, `CAD`, `EUR`, `GBP`, `INR`, `JPY`, `AUD`, `CHF`, `CNY`, `NZD`, `SGD`) with one-tap **Quick Switch** chips and a sticky **Exchange Rate Matrix** table:
* **Automated FX Polling**: Fetches canonical USD-base spot crosses via Yahoo Finance (`CAD=X`, `EUR=X`, `INR=X`, `CHF=X`, etc., dynamically collected across supported currencies, accounts, and holdings) every 2 minutes during market hours (30 minutes off-hours) on the server, paired with a 10-minute in-flight-deduplicated client cache (`currencyCache.ts`) that invalidates immediately when market syncs complete.
* **Reverse Pair Inversion**: Automatically computes mathematical reciprocals ($1 / \text{Rate}$) whenever only the inverted cross exists.

---

## 🏦 3. Accounts *(ADMIN / EDITOR)*

Located at `/settings/accounts`:
* **Create & Edit Accounts**: Assign an account name, tax container type (`TFSA`, `RRSP`, `Roth IRA`, `Taxable`, `Demat`), native currency, and brokerage Platform.
* **Active / Inactive Toggling (`isActive`)**: Deactivating an account excludes it from current Net Worth and Rebalancer scope while keeping historical activities auditable and selectable when editing past entries.
* **Deletion Safeguards**: Accounts with existing transactions cannot be deleted until activities are transferred or removed.

---

## 👥 4. Users & Role-Based Access Control (RBAC)

Located at `/settings/users`:

Strict RBAC is enforced at both API (`requireAuth`) and UI layers:

| Capability | ADMIN | EDITOR | VIEWER |
| :--- | :---: | :---: | :---: |
| View Dashboards, Owner Snapshots & Reports | ✅ | ✅ | ✅ |
| Add, Edit, Import & Migrate Activities (`DRIP`) | ✅ | ✅ | ❌ |
| Trigger Coalesced Portfolio / Symbol Price Refreshes | ✅ | ✅ | ❌ |
| Run Rebalancer & Save FIRE / Rebalance Profiles | ✅ | ✅ | ❌ |
| Manage Accounts & Platforms | ✅ | ✅ | ❌ |
| Manage Master Taxonomy Data & Market Sync | ✅ | ❌ | ❌ |
| Manage Users & Reset Passwords | ✅ | ❌ | ❌ |
| Programmatic MCP Access (`MCP_API_KEY`) | ✅ | ❌ | ❌ |

* Passwords are salted and hashed using `bcryptjs`.

---

## 🗄️ 5. Master Data *(ADMIN)*

Located at `/settings/data`:
* **Platforms**: Brokerage custodians (`Interactive Brokers`, `Questrade`, `Wealthsimple`, `Zerodha`).
* **Investment Types & Yahoo Mapping**: Local asset classes (`Equity`, `ETF`, `Mutual Fund`, `Crypto`, `Fixed Income`) mapped cleanly to upstream Yahoo security types for CSV import auto-categorization.
* **Activity Types**: Transaction definitions (`BUY`, `SELL`, `DIVIDEND`, `DRIP`, `STOCK_SPLIT`, `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_IN`, `TRANSFER_OUT`) with behavioral flags (`ADD`, `REMOVE`, `NEUTRAL`, `SPLIT`).
* **Account Types**: Reusable tax/currency container templates (`TFSA`, `RRSP`, `Taxable`, `401(k)`, etc.).
* **Market Sync Diagnostics & Manual Sync**: Displays live market session status, effective price TTL, active vs. stale symbol counts, last incremental/full run stats, `marketDataVersion`, and throttler cooldown state (`/api/market-data/status`), with **Run Quick Price Sync** and **Run Full Metadata & History Sync** (live streamed output) actions. Note that ETF look-through `countryAllocations` and `topHoldings` pushed from direct-issuer cron jobs (`/api/cron/issuer-allocations`) are preserved across Yahoo fallback refreshes.

---

## 🔐 6. Environment Configuration & Secrets

```env
# Database
DATABASE_URL="postgresql://postgres:postgres@db:5432/portfolio_db"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@db:5432/portfolio_shadow"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your_secure_random_32_byte_secret"
AUTH_TRUST_HOST=true

# Initial Seed Credentials
ADMIN_PASSWORD="your_secure_admin_password"

# Programmatic API & MCP Integration
MCP_API_KEY="your_secure_mcp_api_key_for_external_agents"

# External Cron Webhook Secret (required for /api/cron/issuer-allocations & external cron triggers;
# built-in in-process market sync crons run automatically without it)
CRON_SECRET="your_secure_cron_webhook_secret"

# Optional Market-Hours & Cache Freshness Tuning
MARKET_HOURS_AWARE="true"
PRICE_CACHE_TTL_MS=120000
OFF_HOURS_PRICE_CACHE_TTL_MS=1800000
METADATA_CACHE_TTL_MS=43200000
HISTORY_CACHE_TTL_MS=86400000
MANUAL_REFRESH_COOLDOWN_MS=15000
INCREMENTAL_SYNC_BATCH_SIZE=20
```

* **External Direct-Issuer Cron (`scripts/push-issuer-allocations.ts` & `deploy/k8s/issuer-allocations-cronjob.yaml`)**: Runs direct-issuer ETF adapters (**iShares**, **Vanguard**, **BMO**, **TD**) from a residential/cluster job and pushes gzip-batched fund exposures & underlying holdings to `/api/cron/issuer-allocations` using `ASCEND_URL` and `CRON_SECRET`.
* **Timing-Safe Validation**: `MCP_API_KEY` and `CRON_SECRET` are verified with `crypto.timingSafeEqual` (`src/lib/api-auth.ts`) to prevent timing side-channel leaks.
