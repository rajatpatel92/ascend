# Portfolio Rebalancer

The **Portfolio Rebalancer** is a core strategic module in Ascend designed to maintain asset allocation discipline, prevent portfolio drift, and automate lifecycle investment glide paths.

---

## 🎯 1. The Discipline of Portfolio Rebalancing

Over time, divergent market returns cause a portfolio's actual asset allocation to drift away from the investor's intended target. High-performing assets become overweight (increasing risk exposure), while underperforming or defensive assets become underweight.

The Ascend Rebalancer provides institutional portfolio mechanics:
* Sets target percentage allocations for every holding.
* Calculates real-time allocation weights and dollar drift.
* Generates exact, actionable buy/sell orders with required share counts.
* Implements automated **Glide-Path Drift Adjustments** for target-date retirement strategies.

---

## ⚙️ 2. Target Allocation Configuration

Navigate to **Rebalancer** in the sidebar. Click the **Configure Targets** (gear icon) button to open the target allocation editor:

| Configuration Field | Description | Example |
| :--- | :--- | :--- |
| **Symbol** | The security ticker symbol. Can be selected from current portfolio holdings or searched via Yahoo Finance. | `VTI`, `VXUS`, `BND` |
| **Target Percentage (%)** | The target proportion of the total portfolio allocated to this asset. Total target across all assets should sum to 100%. | `60.0%`, `20.0%`, `20.0%` |
| **Yearly Drift Adjustment (%)** | *(Optional)* The annual adjustment applied to this asset's target allocation (Glide Path). | `-1.0%` for equities, `+1.0%` for bonds |

Targets are stored in the database under the `TargetAllocation` model (`src/app/api/rebalancer/targets`).

---

## 📊 3. Drift Analysis & Calculations

Ascend evaluates the entire portfolio in real-time (`/api/rebalancer`):

1. **Total Portfolio Valuation ($V_{\text{total}}$)**: Sum of all holdings evaluated at current market prices and converted into your active target currency.
2. **Current Weight ($W_{\text{current}}$)**:
   $$W_{\text{current}, i} = \left( \frac{V_{\text{asset}, i}}{V_{\text{total}}} \right) \times 100\%$$
3. **Drift Percentage ($\Delta W_i$)**:
   $$\Delta W_i = W_{\text{current}, i} - W_{\text{target}, i}$$
4. **Drift Monetary Value ($\Delta V_i$)**:
   $$\Delta V_i = V_{\text{asset}, i} - (W_{\text{target}, i} \times V_{\text{total}})$$

### Action Recommendations

Ascend evaluates the sign and magnitude of drift to recommend specific portfolio actions:

* **$\Delta V_i < -\$0.01$ (Underweight)**:
  * **Action**: **`BUY`**
  * **Share Sizing**:
    $$\text{ActionShares}_i = \frac{|\Delta V_i|}{\text{Price}_{\text{native}, i} \times \text{FXRate}}$$
* **$\Delta V_i > +\$0.01$ (Overweight)**:
  * **Action**: **`SELL`**
  * **Share Sizing**:
    $$\text{ActionShares}_i = \frac{\Delta V_i}{\text{Price}_{\text{native}, i} \times \text{FXRate}}$$
* **$|\Delta V_i| \le \$0.01$**:
  * **Action**: **`HOLD`** (In balance)

The rebalancing table sorts assets with the **most underweight positions first**, making it straightforward to allocate new cash deposits into lagging assets without triggering taxable sales.

---

## 📝 4. Trade Execution Checklist

The Rebalancer UI provides an interactive checklist for executing rebalancing trades:

1. **Review Table**: Inspect current weight, target weight, drift %, drift value, recommended action (`BUY`/`SELL`), and exact share counts.
2. **Trade Checkbox**: As you execute orders in your brokerage accounts, click the checkbox on each row to mark the trade completed.
3. **Native Currency Awareness**: Share counts are calculated directly in each asset's native trading currency and execution price to prevent currency rounding discrepancies.

---

## 🛩️ 5. Automated Lifecycle Glide Paths

For investors following lifecycle, target-date, or age-based asset allocation strategies (such as gradually shifting 1% from equities to fixed income each year as retirement approaches):

### How Glide Paths Work
* In **Configure Targets**, assign a **Yearly Drift Adjustment** to specific assets (e.g., `-1.0%` to Equities, `+1.0%` to Fixed Income).
* Ascend tracks `lastAdjustmentDate` on each target.
* **Glide Path Cron Job (`/api/cron/glide-path-adjust`)**:
  * Evaluates all target allocations where `yearlyDriftAdjustment` is defined.
  * When `lastAdjustmentDate` (or creation date) is older than 365 days, the system automatically shifts the `targetPercentage`:
    $$\text{Target}_{\text{new}} = \max(0, \text{Target}_{\text{old}} + \text{YearlyDriftAdjustment})$$
  * Updates `lastAdjustmentDate` to the current timestamp within an atomic Prisma transaction.

This ensures your investment policy statement automatically adapts as you age without manual recalculations.

---

## 🔍 6. Scoped & Filtered Rebalancing

The Rebalancer features advanced filtering to support multi-account or segregated allocation strategies:

* **Filter by Investment Types**: Rebalance only within specific asset classes (e.g., rebalance your Equity slice while keeping Fixed Income separate).
* **Filter by Account Types**: Rebalance only within specific tax wrappers (e.g., rebalance within tax-advantaged accounts like TFSAs/IRAs to avoid triggering capital gains taxes in taxable accounts).
* **Exclude Symbols**: Specify a comma-separated list of ticker symbols to exclude from the rebalancing scope (persisted under `rebalancer_exclude_symbols`).
