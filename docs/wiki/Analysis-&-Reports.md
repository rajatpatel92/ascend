# Analysis & Reports

The **Analysis** module provides specialized analytical lenses to dissect portfolio risk, asset allocation, historical wealth accumulation, and individual asset performance.

---

## 🧭 Sub-Modules Overview

1. **[Allocation](#1-allocation-analysis)**: Interactive multi-dimensional breakdown of portfolio diversification with dual-layer filtering and comprehensive constituent performance.
2. **[Asset Deep-Dive (`/analysis/[symbol]`)](#2-asset-deep-dive-analysissymbol)**: Dedicated holding view with cost-basis overlays, account distribution, and ETF sector/geographic breakdowns.
3. **[Comparison](#3-benchmark-comparison)**: Benchmark your portfolio against standard indices or custom user-defined securities.
4. **[Evolution](#4-wealth-evolution-contributions--dividends)**: Historical Net Asset Value trajectories, net contribution flows, and long-term dividend growth.
5. **[FIRE Calculator](FIRE-Calculator)**: Financial Independence and Retirement decumulation simulation engine.

---

## 🍰 1. Allocation Analysis

Located at `/analysis/allocation`, this page visualizes portfolio exposure and provides a deep constituent audit table.

### Dual-Layer Filtering Architecture

Ascend uses an advanced two-layer filtering model:

1. **Layer 1: Global Filters (`ReportFilters`)**:
   - Filter by **Investment Types** (e.g., Equity, ETF, Fixed Income, Crypto).
   - Filter by **Account Types** (e.g., TFSA, RRSP, Taxable, 401(k)).
   - Persisted across visits under `allocation_filters`.
2. **Layer 2: Interactive Cross-Filtering**:
   - Click directly on any donut chart slice or account category.
   - The entire constituents table immediately sub-slices to display only assets matching the selected category.
   - Supports multi-select via `Ctrl + Click` / `Cmd + Click`.

### Allocation Visualizations & View Modes

The Allocation page provides three distinct perspective views via a dedicated switcher:

1. **Macro X-Ray (Sectors & Geography)** *(Default)*:
   - **By Sector (Look-Through X-Ray)**: Decomposes ETF sector weightings (e.g. VOO's ~30% Technology) and combines them with direct stock holdings (e.g. direct AAPL shares) for true macro sector exposure.
   - **By Geography (Country Exposure)**: Look-through geographic exposure across domestic, North American, European, Asian, and emerging markets.
   - **By Investment Type**: High-level distribution between Equities, ETFs, Crypto, Mutual Funds, and Cash.
2. **Structure & Accounts**:
   - **By Investment Type**: High-level asset class breakdown.
   - **By Account Type**: Distribution across tax containers (Registered/Tax-Advantaged vs. Taxable).
   - **By Account & Platform**: Granular distribution across brokerage institutions and specific accounts.
3. **All Dimensions**:
   - Displays all five allocation charts simultaneously in a responsive grid.

---

### 🔬 Portfolio X-Ray Holding Decomposition Card

When viewing in **Macro X-Ray** or **All Dimensions**, selecting any sector (or viewing the primary exposure sector) reveals the **Portfolio X-Ray Decomposition Card**:

* **Aggregate Exposure Metrics**:
  * Total dollar valuation in the chosen currency and percentage of total portfolio NAV.
* **Direct Equity vs. ETF Look-Through Dual Split**:
  * Quantifies the exact split between direct company stocks and indirect ETF holdings.
  * Visual dual-segmented progress bar clearly shows what portion is held directly versus fund decomposition.
* **Sector Selector Pills**:
  * Quick-access horizontal pill bar allowing users to switch between any portfolio sector without touching the chart.
* **Comprehensive Contributor Overlap Table**:
  * **Holding**: Symbol ticker and company/fund name.
  * **Source Type**: Visual badge distinguishing `Direct Equity` from `ETF Decomposition`.
  * **Holding Value**: Total value of the position in your portfolio.
  * **Weight in Holding**: Percentage of the holding allocated to this sector (e.g., 100% for direct equities, or 30.5% for an S&P 500 ETF).
  * **Sector Exposure**: Dollar contribution of this security to the active sector.
  * **Share of Sector**: Percentage contribution to this sector's total exposure with a visual progress bar.
* **Interactive Cross-Filtering**:
  * Clicking on any sector or country donut slice immediately filters the **Constituents Grid** below, isolating all holdings with exposure to that dimension.


### Deep Constituents Grid (`ConstituentsGrid`)

The table beneath the charts provides granular metrics for every security in the portfolio:

| Column | Description |
| :--- | :--- |
| **Symbol & Name** | Security ticker and company name. Clicking navigates directly to the **[Asset Deep-Dive](#2-asset-deep-dive-analysissymbol)**. |
| **Price & Avg Price** | Current market price alongside your volume-weighted average purchase price (cost basis per share). |
| **Quantity** | Exact shares held, formatted with fractional share precision. |
| **Book Value** | Total cumulative capital invested in native currency and target base currency. |
| **Market Value & Weight** | Current market valuation and percentage weight within the portfolio. |
| **Performance Columns** | Returns across **1D, 1W, 1M, 1Y, YTD, and Inception**. An interactive toggle switches between **Percentage Return (%)** and **Absolute Dollar Profit/Loss ($)**. |
| **Holding XIRR** | Individual dollar-weighted annualized return calculated specifically for that position's cash flows. |
| **Dividends** | Current dividend yield (%), Year-To-Date dividends, and Lifetime cumulative dividends received. |
| **Realized Gains** | Capital gains or losses realized from historical sales of this asset. |

#### Active Assets vs. Sold Assets
* **Active Assets**: Holdings with current quantity $> 0$.
* **Sold Assets Drawer**: Assets that have been completely sold off (quantity $= 0$) are neatly grouped in a collapsible drawer at the bottom of the table. This allows you to audit historical realized gains, lifetime dividends, and total historical return for closed positions.

---

## 🔍 2. Asset Deep-Dive (`/analysis/[symbol]`)

Clicking on any symbol from the Dashboard, Constituents Grid, or Dividend widget opens the **Asset Deep-Dive** page.

### Key Features
* **Summary Hero Card**: Current Market Price, Average Purchase Price, Total Quantity Held, Total Capital Invested, Current Valuation, Absolute Dollar Return, and Percentage Return.
* **Investment Horizon & Trading Stats**:
  * **Investment Age**: Time elapsed since your very first purchase of this security.
  * **Activity Count**: Total number of ledger transactions recorded for this asset.
  * **Total Fees**: Cumulative brokerage fees and commissions paid.
  * **52-Week Range**: Current price plotted against the 52-week high and 52-week low.
* **Cost Basis Overlay Chart (`StockChart`)**:
  * Plots daily historical market prices over time.
  * Overlays your **Average Purchase Price History (`avgPriceHistory`)** as a dynamic baseline, clearly visualizing when your position was in profit or loss across its holding lifecycle.
* **Account Distribution Breakdown**:
  * Visualizes which accounts hold this symbol, share counts per account, and the platform custodying the asset.
* **ETF Sector & Country Allocations**:
  * For ETFs and index funds, Ascend parses underlying fund holdings from market feeds.
  * Displays percentage weights by industry sector (Technology, Financial Services, Healthcare, etc.) and geographic exposure (US, Canada, International, Emerging Markets).
* **Dividend Intelligence**:
  * Total lifetime dividends received for this asset.
  * Current declared dividend rate, forward dividend yield, and historical distribution history.
* **Dedicated Transaction Ledger**:
  * Complete, filterable chronological activity ledger for this symbol.
  * Filter by Activity Type, Account, or Platform.
  * Export symbol history directly to CSV.

---

## ⚖️ 3. Benchmark Comparison

Located at `/analysis/comparison`, this page benchmarks your portfolio's performance against broader financial markets.

### Key Capabilities
* **Dynamic Benchmark Selection**: Compare against default system indices (S&P 500 `^GSPC`, Nasdaq 100 `^IXIC`) or **custom user-defined benchmarks** added via **Settings > General > Benchmarks** (e.g., TSX `^GSPTSE`, Total Stock Market `VTI`, All-World `VT`).
* **Normalized Performance Chart**: Both your portfolio NAV and the benchmark are normalized to $0.00\%$ at the start date of the selected timeframe, enabling a fair apples-to-apples comparison.
* **Supported Time Horizons**: `1M`, `6M`, `YTD`, `1Y`, `2Y`, `3Y`, `5Y`, and `ALL`.
* **Outperformance Metrics**: Clear summary displaying your net alpha (excess return over the benchmark).
* **Leaderboards (Top & Bottom Performers)**:
  * Identifies the best and worst performing individual assets within your portfolio over the selected window, displaying invested capital, ending value, and percentage gain/loss.

---

## 📈 4. Wealth Evolution, Contributions & Dividends

Located at `/analysis/evolution`, this page provides historical insight into wealth accumulation and cash flows.

### 1. Portfolio NAV Evolution Chart
* A historical line chart tracking your total Net Asset Value over time in your Base Currency.
* Unlike percentage comparison charts, this displays true nominal wealth growth.
* Filter-aware: Scope the evolution chart by specific account types or asset classes.

### 2. Contribution Flow Chart (`ContributionChart`)
* Visualizes your **Net Savings Rate & Capital Inflows** over time.
* Toggle between **Weekly**, **Monthly**, and **Yearly** aggregation intervals.
* Visualizes net additions vs net withdrawals, illustrating how much of your portfolio growth is driven by savings versus compound market growth.

### 3. Dividend Growth Chart (`DividendChart`)
* Tracks cumulative and periodic passive dividend income.
* Toggle between **Monthly** and **Yearly** views.
* Demonstrates passive income compounding and annual distribution trends.
