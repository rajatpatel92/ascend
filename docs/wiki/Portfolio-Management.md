# Portfolio Management

Portfolio Management is the operational core of Ascend (`/activities`). It provides an immutable double-entry ledger, multi-currency accounting, first-class **Dividend Reinvestment (`DRIP`)** tracking, automated corporate actions, household **Owner** filtering, and bulk lifecycle workflows.

---

## 🏛️ 1. Hierarchical Architecture: Platforms, Accounts & Investments

Ascend organizes assets across three structural layers:

```
┌────────────────────────────────────────────────────────┐
│                   Platform (Brokerage)                 │
│         e.g., Interactive Brokers, Questrade           │
└───────────────────────────┬────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌──────────────────────┐    ┌──────────────────────┐
   │ Account: "TFSA-CAD"  │    │ Account: "Taxable-USD"│
   │  Currency: CAD       │    │  Currency: USD       │
   │  Status: Active      │    │  Status: Active      │
   └──────────┬───────────┘    └──────────┬───────────┘
              │                           │
              └─────────────┬─────────────┘
                            ▼
              ┌───────────────────────────┐
              │  Investments (Securities) │
              │   e.g., VOO, VFV.TO, AAPL │
              └───────────────────────────┘
```

### Platforms (Master Data)
A **Platform** models the brokerage or custodian holding custody of your assets (e.g., *Interactive Brokers*, *Questrade*, *Wealthsimple*, *Zerodha*), managed in **Settings > Master Data**.

### Accounts
An **Account** represents a legal or tax container within a Platform (`TFSA`, `RRSP`, `Roth IRA`, `401(k)`, `Taxable`, `Demat`, etc.):
* **Currency Isolation**: Each account uses its native currency (`CAD`, `USD`, `INR`, etc.).
* **Active / Inactive Status**: Marking an account inactive excludes it from live Net Worth and Rebalancer scopes while preserving full historical ledger auditability (and inactive accounts remain selectable when editing historical activities).

### Investments
Each security is defined by its Yahoo ticker symbol (`AAPL`, `VFV.TO`, `BTC-USD`), Asset Class (`Equity`, `ETF`, `Mutual Fund`, `Crypto`), and native currency.

---

## 📜 2. Activity Ledger, KPI Strip & Owner Filtering

The revamped **Activities** workspace (`/activities`) gives full visibility and control over your ledger:

### Tier 1 Summary KPI Strip
Updates dynamically in real time as you filter the ledger:
* **Filtered Entries**: Total matching activity count along with an inline count of `DRIP` reinvestments.
* **Net Capital Flow (`Inflow` / `Outflow`)**: Net cash deployed or withdrawn across matching ledger entries in your selected Display Currency (automatically excluding internal `DRIP` reinvestments from fresh investor cash flow).
* **Brokerage Fees**: Cumulative commissions and transaction charges paid across matching entries.

### Multi-Dimensional Filtering
Filter the ledger across:
* **Owner**: Isolate activities belonging to a specific household member/account owner.
* **Date Range**: Preset windows (`1M`, `3M`, `6M`, `YTD`, `1Y`, `ALL`) or custom start/end dates.
* **Account Type**, **Platform**, **Symbol**, and **Activity Type** (`BUY`, `SELL`, `DIVIDEND`, `DRIP`, `STOCK_SPLIT`, `DEPOSIT`, `WITHDRAWAL`, `TRANSFER_IN`, `TRANSFER_OUT`).

### Supported Activity Types

| Type | Behavioral Classification | Description |
| :--- | :--- | :--- |
| `BUY` | Position Addition (`ADD`) | Increases share quantity from fresh capital; records price, fee, and execution date. |
| `DRIP` | Dividend Reinvestment (`ADD`) | First-class reinvested shares lot. Increases held shares & cost basis **without** inflating out-of-pocket investor cash contributions, while remaining tracked in reinvestment analytics. |
| `SELL` | Position Reduction (`REMOVE`) | Decreases share quantity; computes realized gain/loss. |
| `DIVIDEND` | Cash Payout (`NEUTRAL`) | Records cash dividend distributions; accumulates into YTD and lifetime dividend metrics. |
| `STOCK_SPLIT` | Quantity Multiplier (`SPLIT`) | Multiplies share quantity by the split ratio while preserving total cost basis. |
| `DEPOSIT` | Cash Flow Inflow | Cash deposit into an account. |
| `WITHDRAWAL` | Cash Flow Outflow | Cash withdrawal out of an account. |
| `TRANSFER_IN` | Container Migration (`ADD`) | Internal asset receipt into an account without tax realization. |
| `TRANSFER_OUT` | Container Migration (`REMOVE`) | Internal asset exit from an account without tax realization. |

---

## 🤖 3. Corporate Actions Automation & DRIP Engine

### Automated Dividend Detection (`FetchDividendsModal`)
1. Click **Fetch Dividends** in the Activities toolbar.
2. Select target symbols and calendar year; Ascend scans Yahoo Finance history (with activity-ledger & chart-event fallbacks when quote metadata is incomplete) against your historical share balances.
3. **Duplicate & Exclusion Filtering**: Already-recorded dividends are suppressed, and unwanted items can be permanently hidden (`HiddenDividend`).
4. **One-Click Reinvestment (`DRIP`)**: Checking **Reinvest** on any dividend automatically inserts a paired:
   1. `DIVIDEND` entry (cash distribution record).
   2. `DRIP` entry (share purchase funded by the dividend payout at that date's market price).

### Historical DRIP Migration Scanner (`DripMigrationModal`)
If you previously logged dividend reinvestments as standard `BUY` transactions, the **Migrate DRIPs** scanner (`src/lib/drip-migration.ts`, `/api/activities/migrate-drip`) audits your history and converts them cleanly into `DRIP` activities:
* **Confidence Scoring (`HIGH` / `MEDIUM`)**: Pairs historical `DIVIDEND` entries with `BUY` transactions in the same symbol and account within a `-1` to `+5` day window using five match classifications:
  * `BATCH_PAIR`: Paired within 15 seconds during a batch insert.
  * `EXACT_COST`: Reinvestment cost matches the cash dividend amount cleanly.
  * `ROUNDED_DRIP` / `WHOLE_SHARE`: Whole-share brokerage DRIPs where residual cash remains.
  * `NET_OF_TAX`: Matches dividend payout net of foreign withholding tax.
* Select candidates individually or by confidence level to convert `BUY` rows to `DRIP` in a single atomic transaction.

### Automated Stock Split Detector (`SplitService`)
Located in `src/lib/split-detector.ts`:
* Scans Yahoo Finance chart events since each holding's first trade date.
* Ignores minor phantom ratios between `0.90` and `1.10` and ignores future scheduled splits.
* Allocates `STOCK_SPLIT` activities per account holding shares before the split date.

---

## 🔁 4. Account Transfers (`TransferAccountsModal`)

When transferring holdings between brokerages or consolidating accounts:
1. Click **Transfer Accounts** in the Activities toolbar.
2. Choose **Source Account** and **Destination Account**, optionally checking **Deactivate Source Account**.
3. `/api/accounts/transfer` reassigns associated activities to the destination account and updates platform references inside an atomic database transaction.

---

## 📁 5. Bulk Data Management & CSV Import Alias Mapping

### Bulk CSV Import (`BulkUploadModal` & `/api/activities/import`)
Upload brokerage CSV exports with a two-stage validation and execution pipeline:

```csv
Date,Type,Symbol,Quantity,Price,Username,Account Type,Platform,Fee,Currency
2024-01-15,BUY,AAPL,10,185.50,admin,TFSA,Questrade,4.95,USD
2024-03-28,DRIP,VFV.TO,0.25,129.60,admin,RRSP,Interactive Brokers,0,CAD
```

* **Automatic Brokerage Type Alias Normalization (`src/lib/activity-helpers.ts`)**: Common brokerage labels are automatically normalized during pre-flight validation and import:
  * `REINVEST`, `REINVESTMENT`, `DIVIDEND REINVESTMENT`, `DIV REINV`, `Dividend_Reinvest` → **`DRIP`**
  * `DIV`, `DIVIDENDS`, `CASH DIVIDEND` → **`DIVIDEND`**
  * `STOCK SPLIT` → **`STOCK_SPLIT`**
  * `TRANSFER IN` / `TRANSFER OUT` → **`TRANSFER_IN`** / **`TRANSFER_OUT`**
* **Two-Stage Pipeline**: Stage 1 validates headers, users, account types, platforms, and Yahoo ticker symbols (displaying clear alias mapping badges in preview). Stage 2 auto-creates missing `Investment` rows, fetches historical FX rates, and commits everything atomically.

### Bulk Edit, Batch Delete & CSV Export
* **Batch Edit (`BulkEditModal`)**: Multi-select ledger checkboxes to bulk-update Account, Platform, Date, or Activity Type.
* **Batch Delete**: Delete multiple selected activities with `ConfirmDialog` safeguards.
* **CSV Export**: Export filtered or complete ledger history at any time.

---

## 💱 6. Multi-Currency Accounting Architecture

```
[Asset Native Currency] ──(Historical FX on Trade Date)──> [Account Native Currency]
                                                                     │
                                                        (Live Base FX on View Date)
                                                                     │
                                                                     ▼
                                                          [Global Base Currency]
```

1. **Trade Execution**: Historical FX rates on the trade date lock in accurate native cost basis.
2. **Current Valuation**: Holdings convert dynamically into your selected Display Currency via direct and inverted FX pairs (`1 / Rate`).
