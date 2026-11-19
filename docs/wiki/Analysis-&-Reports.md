# Analysis & Reports

The **Analysis** module provides specialized analytical lenses to dissect asset allocation, ETF look-through exposure, benchmark outperformance, historical wealth accumulation, and individual holding lifecycles.

---

## 🧭 Sub-Modules Overview

1. **[Allocation Explorer (`/analysis/allocation`)](#1-allocation-analysis)**: Unified 6-dimension explorer featuring GICS sectors, an interactive **Choropleth World Map**, **Portfolio-Wide Underlying Holdings X-Ray**, and an inline unified **Holdings** table (`ConstituentsGrid`).
2. **[Asset Deep-Dive (`/analysis/[symbol]`)](#2-asset-deep-dive-analysissymbol)**: Individual security view with cost-basis average price overlay (`avgPriceHistory`), account distribution, side-by-side ETF **Geographic Exposure** & **Underlying Holdings** (`$` & `%`), and DRIP stats.
3. **[Benchmark Comparison (`/analysis/comparison`)](#3-benchmark-comparison)**: Normalized portfolio performance vs. system or custom user-defined market indices with top/bottom contributor leaderboards.
4. **[Wealth Evolution (`/analysis/evolution`)](#4-wealth-evolution-contributions--dividends)**: Nominal NAV curve, net investor capital inflows (excluding DRIPs), and dividend vs. DRIP cash-flow history.
5. **[FIRE Calculator (`/analysis/fire`)](FIRE-Calculator)**: Two-phase retirement modeling with saved profiles.

---

## 🍰 1. Allocation Analysis

Located at `/analysis/allocation`, this page visualizes portfolio exposure across six dimensions and feeds a unified, context-aware **Holdings** table.

### Dual-Layer Filtering Architecture
1. **Layer 1: Global Filters (`ReportFilters`)**:
   - Filter by **Investment Types** (Equity, ETF, Mutual Fund, Fixed Income, Crypto) and **Account Types** (TFSA, RRSP, Taxable, 401(k), etc.), persisted across sessions under `allocation_filters`.
2. **Layer 2: Interactive Cross-Filtering**:
   - Click any chart slice, country shape/list row, underlying stock, or legend entry to scope the **Holdings** table below.
   - Supports multi-dimension filtering via `Ctrl + Click` / `Cmd + Click` (automatically scaling X-Ray dollar exposure when narrowed by account or asset type).

### Unified Allocation Explorer (6 Dimensions)
A compact `tablist` switches cleanly across six analytical views without vertical clutter or mobile overflow:
1. **`Sector`** *(Default)*: Look-through GICS sector exposure combining direct stocks (e.g., `AAPL`) with underlying ETF sector weights (e.g., `XEQT.TO`, `VOO`).
2. **`Geography`** (`WorldAllocationMap`): Interactive **dark-to-bright choropleth world map** backed by Natural Earth geometries and small-market markers, paired with a synchronized, full-length country breakdown showing dollar amounts and portfolio percentages.
3. **`Holdings`** (`PortfolioHoldingsXRay`): Portfolio-wide **Underlying Stock X-Ray** combining direct equities and full ETF look-through weights (up to `15,000` disclosed positions per fund via direct **iShares**, **Vanguard**, **BMO**, and **TD** issuer adapters, preserving dual-class shares like `GOOG` vs. `GOOGL` separately). Summarizes Direct Equities, ETF Look-Through Equities, Fixed Income/Cash, and Unattributed Fund Value with instant search, pagination, and contributor drilling.
4. **`Asset Type`**: Asset class breakdown (`ETF`, `Equity`, `Crypto`, `Mutual Fund`, `Cash`).
5. **`Account Type`**: Tax-wrapper breakdown (`TFSA`, `RRSP`, `Taxable`, `Roth IRA`, etc.).
6. **`Account`**: Distribution across individual brokerage accounts and custodians.

---

### 🔬 Unified Scope Banner & Constituents Grid (`ConstituentsGrid`)

Instead of stacking duplicate drill-down tables on top of your portfolio positions, clicking any item across **all 6 tabs** transforms the single **Holdings** card in place (`src/lib/allocation-scope.ts`):

* **Inline Scope / X-Ray Banner**:
  * **X-Ray Tabs (`Sector`, `Geography`, `Holdings`)**: Displays the active `Portfolio X-Ray` badge, selected dimension title, total dollar exposure, `% of Portfolio`, `Clear Filter` button, and a **Direct Holdings vs. ETF Look-Through** split progress strip.
  * **Slice Tabs (`Asset Type`, `Account Type`, `Account`)**: Displays a matching `Portfolio Scope` banner with scoped dollar total, `% of Portfolio`, contextual description, and `Clear Filter` button.
* **Adaptive Grouped Table Columns**:
  * **X-Ray Mode**: Renders `Asset` (with `Direct Holding` / `ETF Look-Through` badge), a highlighted `{Title} Exposure Breakdown` group (`Weight`, `Exposure ($)`, `Share` bar), and compact `Current / Book` (with avg cost/price unit tooltip), `Day`, selected return period, `ALL`, and `XIRR / Div` columns — keeping all metrics visible on 2 clean lines without extra column toggles.
  * **Slice Mode**: Adds a highlighted `{Title} Share` progress column alongside `Book Value`, `Current Value`, `Day`, selected period, `ALL`, `Dividend`, and `XIRR`.
  * **Unfiltered Mode**: Shows the full portfolio valuation & return table plus active-vs-sold asset rollup (`Realized / Sold Assets`).
* **Context-Aware `Return Column` Switcher**:
  * **Unfiltered**: Offers all 5 selectors (`1W`, `1M`, `YTD`, `1Y`, `All` multi-column view).
  * **Filtered**: Hides the expanded `All` multi-column toggle (`1W`, `1M`, `YTD`, `1Y` only) to keep horizontal width crisp alongside X-Ray/Share columns.

---

## 🔍 2. Asset Deep-Dive (`/analysis/[symbol]`)

The individual symbol page provides complete lifecycle diagnostics for any security:

* **Hero & Summary KPI Strip**: Live market price, day change, position market value, cost basis (`Avg Purchase Price`), total shares held, unrealized/realized P&L, **Holding XIRR**, and a role-gated **Refresh** button (`ADMIN` / `EDITOR`) that triggers `POST /api/market-data/refresh` (`{ symbol, mode: 'full' }`) while preserving issuer look-through allocations & `topHoldings`, then broadcasts `MARKET_SYNCED` across open tabs and chart views.
* **Investment Horizon & Trading Stats**: Investment age, total activity count, cumulative brokerage fees, **DRIP Reinvested Shares & Amount**, and 52-week price range bar.
* **Interactive Cost Basis Overlay Chart (`StockChart`)**:
  * Daily price history (`1M`, `3M`, `6M`, `YTD`, `1Y`, `3Y`, `5Y`, `ALL`) with responsive skeleton loading (`SymbolSkeleton`) and automatic revalidation on `MARKET_SYNCED` events.
  * Overlays your historical **`Average Purchase Price (avgPriceHistory)`** step line so you can see exactly when your position traded above or below your cost basis.
  * Plots buy/sell/DRIP execution context directly alongside price action.
* **Account Distribution Breakdown**: Per-account share counts, market values, cost bases, and custodian platforms holding the symbol.
* **ETF Look-Through Breakdown (Sector, Geography & Underlying Holdings)**: Displays full normalized GICS sector mix alongside side-by-side **Geographic Exposure** (complete country list with both `$` valuation and `%` weight) and **Underlying Holdings** (searchable/scrollable ETF constituent table showing `$` and `%` weights fetched from direct-issuer adapters).
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
