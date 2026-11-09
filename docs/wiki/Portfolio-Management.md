# Portfolio Management

Portfolio Management is the operational core of Ascend. It provides an immutable double-entry ledger, multi-currency accounting, automated corporate actions (dividends and stock splits), and bulk lifecycle tools.

---

## 🏛️ 1. Hierarchical Architecture: Platforms, Accounts & Investments

Ascend organizes your assets across three distinct structural layers:

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
A **Platform** models the financial institution or custodian holding custody of your assets (e.g., *Interactive Brokers*, *Questrade*, *Charles Schwab*, *Wealthsimple*, *Zerodha*).
* Created in **Settings > Master Data > Platforms**.
* Defined by a human-readable Name and a unique alphanumeric Slug (e.g., `ibkr`, `questrade`).

### Accounts
An **Account** represents a specific legal or tax container within a Platform (e.g., *RRSP*, *TFSA*, *Roth IRA*, *Taxable Margin*, *Corporate Account*).
* **Currency Isolation**: Each account is designated with its native currency (e.g., CAD or USD). If your brokerage provides dual-currency sub-accounts (e.g., Questrade CAD and USD), model them as two distinct accounts (`Questrade-CAD` and `Questrade-USD`) to maintain exact cash-flow segregation.
* **Active / Inactive Status**: Accounts can be marked as Inactive. Inactive accounts are excluded from current Net Worth calculations and rebalancing operations while preserving their complete historical audit ledger.

### Investments
An **Investment** represents the tradeable asset or security.
* Defined by its ticker symbol (e.g., `AAPL`, `MSFT`, `VFV.TO`, `BTC-USD`).
* Linked to an **Investment Type** (e.g., Equity, ETF, Mutual Fund, Crypto) and a native trading currency code.
* Automatically synchronized with Yahoo Finance for metadata and historical daily pricing.

---

## 🔁 2. Account Transfers (`TransferAccountsModal`)

When you transfer portfolios between brokerages (e.g., transferring a TFSA from Questrade to Interactive Brokers) or consolidate accounts:

1. Click **Transfer Accounts** in the Activities toolbar.
2. Select the **Source Account** and **Destination Account**.
3. **Deactivate Source Account**: Check this option to automatically deactivate the source account post-transfer, archiving it from active views.
4. **Execution Mechanics (`/api/accounts/transfer`)**:
   - Trans-assigns all associated activities from the source account to the destination account.
   - Updates platform linkages atomically within a database transaction.
   - Recalculates cost bases and historical allocations instantly.

---

## 📜 3. Activity Ledger & Transaction Types

All changes to your holdings are recorded as immutable **Activities** in the ledger.

### Supported Activity Types

| Type | Behavioral Classification | Description |
| :--- | :--- | :--- |
| `BUY` | Position Addition | Increases share quantity; records purchase price, fees, and execution date. |
| `SELL` | Position Reduction | Decreases share quantity; triggers realized gain/loss calculations. |
| `DIVIDEND` | Cash Inflow | Records dividend payouts in cash; accumulates into lifetime and YTD dividend metrics. |
| `STOCK_SPLIT` | Quantity Multiplier | Adjusts share quantity by the split factor; preserves total cost basis without artificial P&L spikes. |
| `DEPOSIT` | Cash Flow Inflow | Cash contribution into an account. |
| `WITHDRAWAL` | Cash Flow Outflow | Cash withdrawal out of an account. |
| `TRANSFER_IN` | Container Migration | Internal asset receipt into an account without tax realization. |
| `TRANSFER_OUT`| Container Migration | Internal asset exit from an account without tax realization. |

---

## 📝 4. Smart Activity Entry

Click **Add Activity** to open the smart entry form:

* **Live Symbol Search**: Autocompletes against market databases. Selecting a ticker automatically fills:
  * Company / Fund Name
  * Native Currency
  * Latest Market Close Price
  * Investment Type (Equity, ETF, Mutual Fund)
* **Account Auto-Association**: Selecting an account automatically assigns its parent Platform and validates currency compatibility.
* **Transaction Fields**:
  * Date & Time
  * Quantity (supports fractional shares down to 6 decimal places)
  * Price per unit
  * Commission / Exchange Fees
  * Currency (defaults to asset currency with historical FX conversion).

---

## 🤖 5. Corporate Actions Automation

### Automated Dividend Detection & DRIP Engine
Instead of manually logging monthly or quarterly distributions:

1. Click **Fetch Dividends** in the Activities view.
2. **Step 1 — Symbol Selection**: Select the symbols you wish to scan, and specify the calendar year.
3. **Step 2 — Market Scan**: Ascend queries historical declared dividends from market feeds against your historical holding dates.
4. **Step 3 — Review & Reinvestment (DRIP)**:
   * **Duplicate Detection**: Existing logged dividends are automatically detected and hidden by default.
   * **Hide Option**: Irrelevant dividends can be permanently hidden (stored in the `HiddenDividend` table) so they never reappear in future scans.
   * **Dividend Re-Investment (DRIP)**: Check the **Reinvest** box on any dividend. Ascend automatically generates a paired transaction:
     1. A `DIVIDEND` activity (cash inflow for the payout amount).
     2. A matching `BUY` activity (cash outflow buying shares at that date's market close price).
5. **Batch Add**: Confirm to insert all selected distributions in a single transactional write.

---

### Automated Stock Split Detector (`SplitService`)

Stock splits (e.g., 10-for-1 or 3-for-1 splits) can destroy portfolio return metrics if share counts are not adjusted, creating phantom capital losses.

Ascend features a dedicated background `SplitService` (`src/lib/split-detector.ts`):
* **Automatic Scan**: Queries Yahoo Finance chart events for all held investments from their first activity date.
* **Phantom Split Filtering**: Real splits typically have significant ratios (e.g., 2:1 or 1:2). Ascend filters out data noise by ignoring minor ratios between `0.90` and `1.10`.
* **Future Split Protection**: Ignores splits scheduled for future dates.
* **Account-Level Allocation**: When a split is confirmed, Ascend creates `STOCK_SPLIT` activity entries for every account that held the asset prior to the split date, ensuring exact per-account share reconciliation.

---

## 📁 6. Bulk Data Management & Tools

### Bulk CSV Import (`/api/activities/import`)
Upload historical records from brokerages or third-party tools via the **Import CSV** modal.

#### Required CSV Headers
```csv
Date,Type,Symbol,Quantity,Price,Username,Account Type,Platform,Fee,Currency
2024-01-15,BUY,AAPL,10,185.50,admin,TFSA,Questrade,4.95,USD
2024-03-28,DIVIDEND,VFV.TO,0,32.40,admin,RRSP,Interactive Brokers,0,CAD
```

* **Required Columns**: `Date`, `Type`, `Symbol`, `Quantity`, `Price`, `Username`, `Account Type`, `Platform`.
* **Optional Columns**: `Fee` (defaults to 0), `Currency` (defaults to asset native currency).
* **Two-Stage Validation Engine**:
  * **Stage 1 (Pre-flight Validation)**: Parses headers, verifies row data types, verifies user and account existence, and queries market data to confirm all symbols exist.
  * **Stage 2 (Atomic Execution)**: Automatically creates missing `Investment` records, batches historical FX queries, and writes all activities inside a single database transaction.

### Bulk Edit & Batch Delete (`BulkEditModal`)
Select multiple activities using table checkboxes:
* **Batch Edit**: Simultaneously change Platform, Account, Date, or Type across dozens of records.
* **Batch Delete**: Remove erroneous transactions in bulk with a single confirmation.

### CSV Ledger Export
Download your complete activity ledger at any time for offline auditing, tax preparation, or spreadsheet analysis.

---

## 💱 7. Multi-Currency Accounting Architecture

Ascend treats foreign exchange as a first-class citizen:

```
[Asset Native Currency] ──(Historical FX on Trade Date)──> [Account Native Currency]
                                                                     │
                                                        (Live Base FX on View Date)
                                                                     │
                                                                     ▼
                                                          [Global Base Currency]
```

1. **Trade Execution**: When buying a foreign asset (e.g., USD stock in a CAD account), Ascend captures the historical exchange rate on that date to lock in your true native cost basis.
2. **Current Valuation**: Current market values are converted from the asset's trading currency into your chosen Base Currency using live daily exchange rates.
3. **Direct & Inverted FX Pairs**: Ascend supports major currency pairs (`CAD=X`, `EUR=X`, `GBP=X`, `INR=X`, `JPY=X`, `AUD=X`). If a direct rate is unavailable, the system automatically checks and inverts the reverse currency pair ($1 / \text{Rate}$).
