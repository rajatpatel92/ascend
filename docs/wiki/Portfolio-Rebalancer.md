# Portfolio Rebalancer

The **Portfolio Rebalancer** (`/rebalancer`) is a strategic portfolio discipline engine designed to keep holdings aligned with your target policy, deploy new contributions cleanly, minimize unnecessary capital-gains taxes, and simulate lifecycle glide paths.

---

## 🎯 1. Core Capabilities

* **Rebalance Modes (`FULL` vs. `BUY_ONLY`)**: Rebalance via full Buys + Sells, or deploy **New Cash Inflow** exclusively into underweight assets without triggering taxable sales.
* **Target Dimensions (`TICKER` vs. `CATEGORY`)**: Define targets per individual ticker symbol or at the **Asset Class / Investment Type** level (distributing category trades pro-rata across underlying constituents).
* **Drift Tolerance Bands (`tolerancePercent`)**: Suppress micro-trades for positions sitting inside your acceptable percentage deadband (e.g., `±1.0%`), keeping portfolio turnover low.
* **Whole-Share vs. Fractional Sizing**: Toggle whole-share trade rounding (`BUY_ONLY` floors share counts to stay strictly within your cash budget; `SELL` never oversells held shares).
* **Tax-Aware Account Routing**: Suggests which brokerage accounts to execute trades in, prioritizing **Tax-Free** (`TFSA`, `Roth IRA`, `FHSA`, `PPF`, `NRE`) and **Tax-Deferred** (`RRSP`, `LIRA`, `RESP`, `401(k)`, `Traditional IRA`, `EPF`, `NPS`) containers ahead of **Taxable** accounts when selling, flagging taxable capital-gains warnings.
* **Saved Rebalance Profiles**: Save and switch between multiple named allocation strategies (`Default Portfolio` and custom scoped profiles) stored via `/api/rebalancer/profiles`.
* **Interactive Glide-Step Simulator**: Preview `+1Y` projected allocation weights based on annual drift adjustments and validate net-zero drift schedules.

---

## ⚙️ 2. Strategy Controls & Target Configuration

### Strategy Panel
1. **Saved Profiles Bar**: Switch active rebalance profiles, create/save new profiles, or bind Account Type / Investment Type filters and excluded symbols directly to a profile.
2. **Mode Switcher**:
   * **Full Rebalance (`FULL`)**: Generates `BUY` and `SELL` orders to match target weights strictly.
   * **Buy-Only (+ Cash Inflow) (`BUY_ONLY`)**: Enter a new deposit amount (`newCash`) and distribute cash proportionally across underweight targets (`unallocatedCash` tracks any whole-share remainder).
3. **Drift Tolerance Band (%)**: Holdings whose $|\Delta W_i| \le \text{tolerancePercent}$ remain **`HOLD`**, preventing unnecessary churn.
4. **Dimension Toggle (`Ticker Targets` vs. `Category Targets`)**: Switch between security-level targets and asset-class targets (`ETF`, `Equity`, `Fixed Income`, etc.).
5. **Whole Shares Toggle**: Floor fractional shares cleanly for brokerages without fractional order support.

### Configure Targets Modal
| Field | Description | Example |
| :--- | :--- | :--- |
| **Symbol / Category** | Security ticker (Yahoo search or current holdings) or Investment Type | `VTI`, `VXUS`, `BND` / `Equity` |
| **Target Percentage (%)** | Intended portfolio weight (total across active targets should equal `100.0%`; includes one-click **Normalize to 100%** and **Seed from Holdings**) | `60.0%`, `20.0%`, `20.0%` |
| **Yearly Drift Adjustment (%)** | *(Optional)* Annual target shift for lifecycle glide paths | `-1.0%` equities, `+1.0%` bonds |

---

## 📊 3. Drift Math, Summary Metrics & Visualizations

Ascend evaluates portfolio weights in your selected display currency (`src/lib/rebalance-planner.ts` & `src/lib/rebalance-extensions.ts`):

1. **Current Weight ($W_{\text{current}}$)**:
   $$W_{\text{current}, i} = \left( \frac{V_{\text{asset}, i}}{V_{\text{total}}} \right) \times 100\%$$
2. **Drift Percentage ($\Delta W_i$) & Monetary Drift ($\Delta V_i$)**:
   $$\Delta W_i = W_{\text{current}, i} - W_{\text{target}, i}$$
   $$\Delta V_i = V_{\text{asset}, i} - (W_{\text{target}, i} \times V_{\text{total}})$$
3. **Summary Diagnostics**: Displays **Total Buy Value**, **Total Sell Value**, **Portfolio Turnover %**, **Max Absolute Drift**, **Out-of-Band Count**, and **Unallocated Cash**.
4. **Interactive Charts**: Visual comparison charts plotting **Current vs. Target Allocation Weights** and **Post-Trade Projected Weights**.

---

## 🏦 4. Tax-Aware Account Routing & Trade Checklist

When a position spans multiple accounts (e.g., held in both a `TFSA`, `RRSP`, and `Taxable Margin` account), expanding a rebalance row reveals per-account trade guidance (`allocateTradeAcrossAccounts`):
* **Sell Prioritization**: Sells are routed to **`Tax-Free`** accounts first, **`Tax-Deferred`** accounts second, and **`Taxable`** accounts last—displaying a clear **`Taxable Sale`** warning badge whenever a taxable liquidation is unavoidable.
* **Buy Routing**: Allocates buys across eligible active accounts within scope.
* **Trade Execution Checklist**: Mark rows complete as you place orders in your brokerage; share counts respect native trading currencies and execution prices.

---

## 🛩️ 5. Automated Lifecycle Glide Paths & Simulator

For target-date or age-based allocation policies (such as shifting `-1.0%` per year from equities into fixed income):
* **Glide-Step Simulator (`simulateGlideStep`)**: Preview your target allocation `+1Y` forward inside the UI before committing, with automatic net-drift validation (`netAnnualDrift !== 0` warning if additions and reductions don't balance to zero).
* **Scheduled Cron Adjuster (`/api/cron/glide-path-adjust`)**: Evaluates `TargetAllocation` records with `yearlyDriftAdjustment` and shifts targets atomically every 365 days (`Math.max(0, target + adjustment)`), syncing changes cleanly with saved rebalance profiles.

---

## 🔍 6. Scoped & Filtered Rebalancing

* **Filter by Investment Types & Account Types**: Rebalance inside a single tax wrapper (e.g., `TFSA` + `RRSP`) or asset class without affecting other accounts.
* **Exclude Symbols**: Exclude concentrated legacy positions or cash equivalents from target calculations (can be toggled directly per row or saved with a profile under `rebalancer_exclude_symbols`).
