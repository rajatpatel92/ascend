# Dashboard

The **Dashboard** is the executive command center of Ascend, delivering an institutional-grade overview of your multi-account, multi-currency portfolio at a glance.

---

## 🎛️ Header & Global Report Filters

At the top of the Dashboard, you are greeted with the current system date and an interactive **Report Filters** control:

* **Greeting & Session Context**: Displays a time-aware greeting ("Good Morning / Afternoon / Evening, <Name>") and system date.
* **Persistent Report Filters (`ReportFilters`)**: Allows you to filter your entire dashboard dynamically by:
  * **Investment Types** (e.g., Equity, ETF, Mutual Fund, Fixed Income, Crypto)
  * **Account Types** (e.g., TFSA, RRSP, Taxable, 401(k), IRA, Demat)
* **Session Persistence**: Filter configurations are persisted locally via `usePersistentState` under `dashboard_filters`, ensuring your customized view remains intact across browser sessions without recalculating.

---

## 💎 Key Widgets & Metric Cards

### 1. Total Net Worth (Hero Card)
The central focal point of the dashboard:
* **Current Net Worth**: The consolidated market value of all active holdings across all connected platforms and accounts, converted into your currently active **Base Currency** (e.g., USD, CAD, EUR, INR) using the latest market FX rates.
* **Day Change**: Both the absolute dollar movement and percentage return since the previous market close:
  $$\Delta \text{Day} = \sum_{i=1}^{M} \left( \text{Quantity}_i \times (\text{Price}_{i, \text{today}} - \text{Price}_{i, \text{prev\_close}}) \times \text{FXRate}_{i, \text{today}} \right)$$
* For foreign holdings, Day Change reflects both native asset price appreciation and intraday currency movements.

---

### 2. Portfolio XIRR (Extended Internal Rate of Return)

**What is it?**
XIRR is your **Dollar-Weighted Return (Money-Weighted Return)**. It answers the fundamental investor question:
> *"Accounting for the exact dates and amounts I contributed and withdrew money, what annualized constant rate of return did my capital achieve?"*

XIRR measures **personal investor performance**. If you contribute heavily just before a major market rally, your XIRR will outperform the benchmark; conversely, if you deploy capital before a drawdown, your personal timing drag is reflected.

**The Mathematical Formulation:**
Ascend solves for the annual discount rate $r$ that brings the Net Present Value (NPV) of all cash flows to zero using the **Newton-Raphson approximation algorithm**:

$$\sum_{i=0}^{N} \frac{C_i}{(1+r)^{\frac{d_i - d_0}{365}}} = 0$$

Where:
* $C_i$: Cash flow on date $d_i$.
  * **Negative cash flow ($-C_i$)**: Capital outflows from the investor's perspective (buying shares, cash deposits).
  * **Positive cash flow ($+C_i$)**: Capital inflows to the investor (selling shares, cash withdrawals, dividend payments).
  * **Final Terminal Inflow ($+C_N$)**: The current market value of your portfolio on today's date $d_N$.
* $d_0$: The date of the very first transaction (inception date).
* $r$: The annualized return rate ($XIRR$).

**1-Year Age Guard (`<1Y`):**
> [!NOTE]
> Annualizing short-term returns (e.g., extrapolating a 10% gain over 15 days to an astronomical annualized rate) distorts portfolio metrics. Ascend automatically detects whether your portfolio history is under one year. If so, it displays **`N/A (<1Y)`** instead of a misleading annualized figure.

---

### 3. All Time Return (Time-Weighted Growth)

Displayed adjacent to XIRR, this metric isolates performance from capital injection timing:
* **Absolute Dollar Growth**: The total cumulative dollar profit realized and unrealized across your portfolio since inception ($\text{Current NAV Value} - \text{Net Capital Invested}$).
* **Total Return Percentage Pill**: The cumulative percentage return derived from the **Time-Weighted Return (TWR)** Net Asset Value unitization.

#### Time-Weighted Return (TWR) & Daily Unitization Mechanics
TWR treats your personal portfolio identically to an institutional Mutual Fund:
1. **Day 0 (Inception)**: Base Net Asset Value (NAV) is initialized to $100.00$.
2. **Daily Unit Valuation**:
   $$NAV_t = NAV_{t-1} \times \left( \frac{\text{PassiveValue}_t}{\text{MarketValue}_{t-1}} \right)$$
   * $\text{PassiveValue}_t$: The value of yesterday's holdings evaluated at today's prices (strictly ignoring any new deposits or withdrawals executed today).
   * $\text{MarketValue}_{t-1}$: The total closing value of the portfolio yesterday.
3. **Cumulative Growth Formula**:
   $$\text{TWR} = \left( \frac{NAV_{\text{current}} - NAV_{\text{inception}}}{NAV_{\text{inception}}} \right) \times 100\%$$

**Why use both XIRR and TWR?**
* **TWR** isolates how well your underlying asset allocation performed, eliminating distortion from personal savings rates.
* **XIRR** measures your personal dollar efficiency, reflecting the combined impact of asset performance and deposit timing.

---

## ⚡ Insights Grid

### 1. Top Movers (1D Portfolio Impact)
Unlike primitive trackers that sort purely by raw percentage change (which highlights volatile penny stocks with negligible dollar holdings), Ascend calculates **Portfolio Impact Percentage**:

$$\text{Impact \%} = \frac{\Delta \text{Value}_{\text{asset, 1D}}}{\text{Total Portfolio Value}_{\text{prev\_day}}} \times 100\%$$

* **Top Gainers**: Assets contributing the highest positive basis points to total portfolio net worth today.
* **Top Losers**: Assets causing the largest drag on total portfolio net worth today.
* **"View All" Modal (`TopMoversModal`)**: Opens a dedicated full-screen drawer displaying all held constituents sorted by dollar and percentage impact, complete with position weights and ticker drill-downs.

---

### 2. Dividend Summary Widget
Provides immediate visibility into passive cash flows:
* **Received YTD**: Actual cumulative dividend payments received from January 1st of the current calendar year to today, converted to your base currency, alongside the YTD yield on total portfolio value.
* **Projected Annual Income**: Forward-looking 12-month expected dividend income based on your current share counts, declared dividend rates, and frequency analysis.
* **Upcoming Ex-Dividend Dates**: A chronological schedule of upcoming ex-dividend dates for your holdings (fetched from market data), displaying the ex-date and estimated payout amount. Clicking any dividend navigates directly to that asset's **[Asset Deep-Dive](Analysis-&-Reports#asset-deep-dive-analysissymbol)**.

---

## 📈 Dual Interactive Charts

### 1. Performance Chart (Time-Weighted Return %)
Visualizes your percentage return curve over time:
* **Supported Ranges**: `1D` (intraday session curve), `1W`, `1M`, `3M`, `6M`, `YTD`, `1Y`, `2Y`, `3Y`, `5Y`, `ALL`.
* **Custom Range Picker**: Select arbitrary start and end dates.
* **Filter Synchronization**: If you have active Report Filters (e.g., viewing only Retirement accounts or only Tech ETFs), the performance chart recalculates the NAV curve specifically for that sub-portfolio.

### 2. Portfolio Evolution Chart (Valuation Curve)
Plots the absolute monetary valuation of your portfolio over time in your selected Base Currency. Shows the visual trajectory of your wealth accumulation through both contributions and market gains.

---

## 🔄 Market Data Sync & Refresh Indicators

At the bottom of the Dashboard, Ascend displays the exact timestamp of the **Last Data Refresh**. 

* **Automatic Background Sync**: Handled by the internal cron scheduler (`instrumentation.ts`):
  * **Every 2 Minutes**: Incremental market price refresh (`/api/cron/market-data/incremental`).
  * **Every Hour**: Full market data refresh (historical daily prices, sector allocations, dividend declarations).
* **Manual Refresh**: Can be triggered anytime from Settings or via individual asset pages.
