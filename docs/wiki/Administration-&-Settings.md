# Administration & Settings

The **Settings** module allows administrators and users to customize workspace preferences, manage users and roles, control currency conversion rates, configure benchmarks, and maintain foundational master taxonomy data.

---

## 🧭 Settings Navigation Hub

Settings are organized across five dedicated sections accessible from the sub-navigation sidebar (`/settings/layout.tsx`):

1. **[General](#1-general-preferences--benchmarks)**: Interface themes, date formats, default currency, benchmark indices, and AI credentials.
2. **[Currency](#2-currency-management--exchange-rates)**: Active currency rates, automated FX polling, and manual rate overrides.
3. **[Accounts](#3-account-management)**: Account configuration, active/inactive toggling, and platform associations.
4. **[Users](#4-user-management--rbac)**: User provisioning, role assignments, password management, and individual AI opt-in.
5. **[Master Data](#5-master-data--taxonomy)**: System taxonomies including Platforms, Investment Types, Activity Types, and Account Types.

---

## ⚙️ 1. General Preferences & Benchmarks

Located at `/settings`:

### User Interface Preferences
* **Theme**: Select between **Light Mode** and **Dark Mode**. Persisted locally in your browser to prevent layout flickering.
* **Date Format (`DateContext`)**: Customize how dates appear across all tables, charts, and transaction ledgers:
  * `MM/DD/YYYY` (US Standard)
  * `DD/MM/YYYY` (UK, Europe, India, International)
  * `YYYY-MM-DD` (ISO 8601 Standard)
  * `MMM DD, YYYY` (Medium Form: "Jan 15, 2025")
* **Default Base Currency**: Select your primary currency for consolidating net worth and dashboard analytics.

### Benchmark Index Configuration (`BenchmarkSettings`)
Customize the benchmark comparison list available in **Analysis > Comparison**:
* **System Benchmarks**: Pre-seeded indices including the S&P 500 (`^GSPC`) and Nasdaq 100 (`^IXIC`).
* **Custom Benchmarks**: Add any global index or ETF tracked by Yahoo Finance (e.g., TSX Composite `^GSPTSE`, All-Country World Index `ACWI`, Vanguard Total Stock Market `VTI`).
* Benchmarks are stored in the database (`Benchmark` model) and updated during automated cron refreshes.

### AI Engine Configuration (`AISettings`)
Administrators can input API credentials for Google Gemini, OpenAI, and Claude, and toggle the global platform-wide AI switch.

---

## 💱 2. Currency Management & Exchange Rates

Located at `/settings/currency`:

Ascend natively supports 11 major global currencies:

| Code | Name | Symbol |
| :--- | :--- | :--- |
| `USD` | US Dollar | `$` |
| `CAD` | Canadian Dollar | `C$` |
| `EUR` | Euro | `€` |
| `GBP` | British Pound | `£` |
| `INR` | Indian Rupee | `₹` |
| `JPY` | Japanese Yen | `¥` |
| `AUD` | Australian Dollar | `A$` |
| `CHF` | Swiss Franc | `Fr` |
| `CNY` | Chinese Yuan | `¥` |
| `NZD` | New Zealand Dollar | `NZ$` |
| `SGD` | Singapore Dollar | `S$` |

### Exchange Rate Mechanics
* **Automated Sync**: The system queries real-time currency exchange rates from Yahoo Finance (e.g., `CAD=X`, `EUR=X`, `INR=X`).
* **Reverse Pair Inversion**: If a direct currency cross is unavailable, Ascend automatically checks and computes the mathematical reciprocal ($1 / \text{Rate}$).
* **Manual Override**: Administrators can manually override exchange rates directly in the interface.

---

## 🏦 3. Account Management

Located at `/settings/accounts`:

* **Create Account**: Define a descriptive name, select the account type (e.g., TFSA, RRSP, Taxable), assign the native currency, and associate it with a Platform.
* **Active / Inactive Status (`isActive`)**: Toggle accounts active or inactive. Inactive accounts are hidden from current Net Worth and Rebalancer tables while retaining all historical activities for audit accuracy.
* **Account Deletion Safeguards**: Accounts containing active transactions cannot be deleted until all transactions are transferred or removed.

---

## 👥 4. User Management & RBAC

Located at `/settings/users`:

Ascend features strict **Role-Based Access Control (RBAC)** enforced at both the API layer (`requireAuth`) and UI layer:

### Role Permissions Matrix

| Capability | ADMIN | EDITOR | VIEWER |
| :--- | :---: | :---: | :---: |
| View Dashboards & Reports | ✅ | ✅ | ✅ |
| View Constituents & Ledgers | ✅ | ✅ | ✅ |
| Use AI Portfolio Assistant | ✅ *(if enabled)* | ✅ *(if enabled)* | ✅ *(if enabled)* |
| Add & Edit Activities / CSV Import | ✅ | ✅ | ❌ |
| Run Rebalancer & Configure Targets | ✅ | ✅ | ❌ |
| Manage Accounts & Platforms | ✅ | ✅ | ❌ |
| Manage Master Taxonomy Data | ✅ | ❌ | ❌ |
| Manage Users & Reset Passwords | ✅ | ❌ | ❌ |
| Configure LLM API Keys & System Secrets | ✅ | ❌ | ❌ |
| Programmatic API Key Access (`MCP_API_KEY`) | ✅ | ❌ | ❌ |

### User Security
* Passwords are encrypted using salted `bcryptjs` hashing.
* Individual users can be toggled to enable or disable access to conversational AI (`aiEnabled`).

---

## 🗄️ 5. Master Data & Taxonomy

Located at `/settings/data`:

This section defines the foundational domain models of your portfolio:

* **Platforms**: Brokerage institutions and crypto custodians (e.g., Interactive Brokers, Questrade, Coinbase).
* **Asset Classes / Investment Types**:
  * Define asset classes (e.g., Equity, ETF, Mutual Fund, Crypto, Fixed Income).
  * **Yahoo Investment Types Mapping**: Maps native Yahoo Finance security types to your local asset classes for seamless categorization during imports.
* **Activity Types**:
  * System transaction types (`BUY`, `SELL`, `DIVIDEND`, `STOCK_SPLIT`, `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_IN`, `TRANSFER_OUT`).
  * Behavioral flags: `ADD` (increases balance), `REMOVE` (decreases balance), `NEUTRAL` (no change to balance).
* **Account Types**: Global account categories (e.g., RRSP, TFSA, Taxable, 401(k), Roth IRA, HSA, Demat).

---

## 🔐 6. Environment Configuration & Secrets

Ascend is configured via environment variables in `.env`:

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

# Programmatic API & Agent Integration
MCP_API_KEY="your_secure_mcp_api_key_for_external_agents"

# Background Automation Secret
CRON_SECRET="your_secure_cron_webhook_secret"
```

* **Timing Attack Prevention**: Secret tokens (`MCP_API_KEY` and `CRON_SECRET`) are evaluated using `crypto.timingSafeEqual` constant-time comparisons (`src/lib/api-auth.ts`), eliminating timing side-channel exploits.
