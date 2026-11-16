# Analysis & Reports

The **Analysis** module provides specialized analytical lenses to dissect asset allocation, ETF look-through exposure, benchmark outperformance, historical wealth accumulation, and individual holding lifecycles.

---

## 🧭 Sub-Modules Overview

1. **[Allocation Explorer (`/analysis/allocation`)](#1-allocation-analysis)**: Unified 5-dimension explorer with on-demand **Portfolio X-Ray** decomposition and cross-filtered constituents audit table.
2. **[Asset Deep-Dive (`/analysis/[symbol]`)](#2-asset-deep-dive-analysissymbol)**: Redesigned individual security view with cost-basis average price overlay (`avgPriceHistory`), account distribution, ETF sector/geography breakdowns, and DRIP stats.
3. **[Benchmark Comparison (`/analysis/comparison`)](#3-benchmark-comparison)**: Normalized portfolio performance vs. system or custom user-defined market indices with top/bottom contributor leaderboards.
4. **[Wealth Evolution (`/analysis/evolution`)](#4-wealth-evolution-contributions--dividends)**: Nominal NAV curve, net investor capital inflows (excluding DRIPs), and dividend vs. DRIP cash-flow history.
5. **[FIRE Calculator (`/analysis/fire`)](FIRE-Calculator)**: Two-phase retirement modeling with saved profiles.

---

## 🍰 1. Allocation Analysis

Located at `/analysis/allocation`, this page visualizes portfolio exposure across five dimensions and feeds a live cross-filtered constituents audit table.

### Dual-Layer Filtering Architecture
1. **Layer 1: Global Filters (`ReportFilters`)**:
   - Filter by **Investment Types** (Equity, ETF, Mutual Fund, Fixed Income, Crypto) and **Account Types** (TFSA, RRSP, Taxable, 401(k), etc.), persisted across sessions under `allocation_filters`.
2. **Layer 2: Interactive Cross-Filtering**:
   - Click any donut slice or legend entry to isolate matching holdings in the Constituents Grid below (active filter badges appear at the top for quick clearing).
   - Supports multi-dimension filtering via `Ctrl + Click` / `Cmd + Click`.

### Unified Allocation Explorer (5 Dimensions)
A streamlined tab bar switches cleanly across five analytical dimensions without vertical clutter or mobile overflow:
1. **`By Sector`** *(Default)*: Look-through GICS sector exposure combining direct stocks (e.g., `AAPL`) with underlying ETF sector weights (e.g., `VOO`).
2. **`By Geography`**: Look-through country exposure combining direct positions and ETF geographic allocations.
3. **`By Investment Type`**: Asset class breakdown (`ETF`, `Equity`, `Crypto`, `Mutual Fund`, `Cash`).
4. **`By Account Type`**: Tax-wrapper breakdown (`TFSA`, `RRSP`, `Taxable`, `Roth IRA`, etc.).
5. **`By Account & Platform`**: Distribution across individual brokerage accounts and custodians.

---

### 🔬 On-Demand Portfolio X-Ray Decomposition (`SectorBreakdownCard`)

When inspecting **`By Sector`** or **`By Geography`**, clicking any slice opens the **On-Demand Portfolio X-Ray** panel right beside/below the explorer:

* **Aggregate Exposure Metrics**: Total dollar valuation and percentage weight of that sector or country across your entire filtered portfolio.
* **Direct Equity vs. ETF Look-Through Dual Split**: Dual-segmented progress bar quantifying how much exposure comes from direct stock picks versus underlying ETF decomposition.
* **Contributor Overlap Table**: Breaks down every security contributing to the active sector/country with:
  * **Source Type Badge**: `Direct Equity` vs. `ETF Decomposition`.
  * **Holding Value**, **Weight in Holding %**, **Allocated Exposure ($)**, and **Share of Dimension %**.

---

### Deep Constituents Grid (`ConstituentsGrid`)

| Column | Description |
| :--- | :--- |
| **Symbol & Name** | Security ticker and company name (links directly to `/analysis/[symbol]`). |
| **Price & Avg Price** | Current market price alongside volume-weighted average cost basis per share. |
| **Quantity** | Fractional share precision up to 6 decimal places. |
| **Book Value** | Total cumulative cost basis in native currency and display currency. |
| **Market Value & Weight** | Live valuation and portfolio weight percentage. |
| **Performance Columns** | Returns across **1D, 1W, 1M, 1Y, YTD, and Inception**, toggleable between **Percentage (%)** and **Dollar P&L ($)**. |
| **Holding XIRR** | Position-specific annualized dollar-weighted return (with `<1Y` guard). |
| **Dividends** | Current yield (%), YTD dividends, and lifetime distributions received. |
| **Realized Gains** | Capital gains or losses locked in from historical sales. |

* **Active Assets vs. Sold Assets Drawer**: Closed positions (`quantity = 0`) collapse neatly into a toggleable drawer for auditing historical realized gains and lifetime dividends.

---

## 🔍 2. Asset Deep-Dive (`/analysis/[symbol]`)

The redesigned individual symbol page provides complete lifecycle diagnostics for any security:

* **Hero & Summary KPI Strip**: Live market price, day change, position market value, cost basis (`Avg Purchase Price`), total shares held, unrealized/realized P&L, **Holding XIRR**, and a role-gated **Refresh** button (`ADMIN` / `EDITOR`) that triggers `POST /api/market-data/refresh` (`{ symbol, mode: 'full' }`) and broadcasts `MARKET_SYNCED` across open tabs and chart views.
* **Investment Horizon & Trading Stats**: Investment age, total activity count, cumulative brokerage fees, **DRIP Reinvested Shares & Amount**, and 52-week price range bar.
* **Interactive Cost Basis Overlay Chart (`StockChart`)**:
  * Daily price history (`1M`, `3M`, `6M`, `YTD`, `1Y`, `3Y`, `5Y`, `ALL`) with responsive skeleton loading (`SymbolSkeleton`) and automatic revalidation on `MARKET_SYNCED` events.
  * Overlays your historical **`Average Purchase Price (avgPriceHistory)`** step line so you can see exactly when your position traded above or below your cost basis.
  * Plots buy/sell/DRIP execution context directly alongside price action.
* **Account Distribution Breakdown**: Per-account share counts, market values, cost bases, and custodian platforms holding the symbol.
* **ETF Look-Through Breakdown**: Displays underlying sector and geographic country weights parsed from market data feeds.
* **Dividend Intelligence**: Lifetime cash + reinvested dividends, declared forward rate/yield, and distribution history.
* **Filterable Symbol Ledger & CSV Export**: Filter chronological transactions by Activity Type, Account, or Platform and export directly to CSV.

---

## ⚖️ 3. Benchmark Comparison

Located at `/analysis/comparison`:
* **Dynamic Benchmark Selection**: Compare portfolio TWR against pre-seeded system indices (`^GSPC` S&P 500, `^IXIC` Nasdaq 100) or **custom benchmarks** added in **Settings > General** (e.g., `^GSPTSE`, `VTI`, `VT`).
* **Normalized Return Curve**: Both portfolio NAV and benchmark series normalize to `0.00%` at the start of the selected horizon (`1M`, `6M`, `YTD`, `1Y`, `2Y`, `3Y`, `5Y`, `ALL`).
* **Alpha & Performer Leaderboards**: Displays net excess return (alpha) alongside top and bottom contributing portfolio holdings over the exact comparison window.

---

## 📈 4. Wealth Evolution, Contributions & Dividends

Located at `/analysis/evolution`:
1. **Portfolio NAV Evolution Chart**: Nominal monetary portfolio valuation curve over time, aligned strictly with Dashboard live Net Worth on the terminal point and scoped by active Report Filters.
2. **Contribution Flow Chart (`ContributionChart`)**: Plots net additions vs. withdrawals across **Weekly**, **Monthly**, and **Yearly** intervals. First-class `DRIP` entries are cleanly excluded from fresh investor out-of-pocket contributions so savings rate calculations stay exact.
3. **Dividend Growth Chart (`DividendChart`)**: Tracks **Monthly** and **Yearly** passive distributions, distinguishing **Cash Dividends** from **`DRIP` Reinvested Dividends**.
