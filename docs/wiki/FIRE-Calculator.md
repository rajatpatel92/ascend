# FIRE Calculator

The **FIRE (Financial Independence, Retire Early) Calculator** (`/analysis/fire`) is a retirement projection and decumulation simulation studio with saved scenario profiles.

Unlike simplistic static rules of thumb (e.g., `25 × annual expenses`), Ascend models monthly compounding, inflation-adjusted withdrawals, lifestyle sustainability checks, dual mathematical modes, and persisted multi-scenario planning.

---

## ⚙️ 1. Core Parameters & Collapsible Simulation Studio

### Collapsible Simulation Parameters Studio (`FireConfigPanel`)
The FIRE planner provides a collapsible studio card so you can tune assumptions on the fly and immediately reclaim screen space for charts and projection schedules once configured:

| Parameter | Description | Default |
| :--- | :--- | :--- |
| **Current Portfolio Value** | Automatically imported from live portfolio Net Worth and converted into the profile's target currency. | Live Net Worth |
| **Target FIRE Date (`YYYY-MM`)** | Target year and month when contributions stop and retirement withdrawals begin. | Today + 10 Years |
| **Monthly Contribution** | Planned monthly savings during the accumulation phase. | `$2,000` |
| **Expected Annual Return (%)** | Nominal annualized compound investment return. | `7.0%` |
| **Inflation Rate (%)** | Annual compound inflation applied to future expenses and retirement withdrawals. | `2.5%` |
| **Current Monthly Expenses** | Baseline monthly living expenses used for **Lifestyle Analysis**. | `$2,000` |

### Saved FIRE Profiles (`src/lib/fire-profiles.ts` & `/api/fire/profiles`)
Save, switch between, update, or delete named retirement scenarios (e.g., *Lean FIRE*, *Coast FIRE*, *Fat FIRE*, *USD vs. CAD Base*) directly from the header profile bar:
* Each profile stores its own name, normalized currency, `lastUpdated`, and sanitized simulation parameters inside `SystemSetting` (`fire_profiles_v1`).
* Switching profiles updates both the live Net Worth currency conversion and simulation inputs automatically.

---

## 🔀 2. Dual Simulation Modes

```
Mode 1: FIXED_RATE    ──> "I want to withdraw 4%. How many years will my money last?"
Mode 2: FIXED_HORIZON ──> "I plan to be retired for 35 years. What withdrawal rate can I sustain?"
```

### Mode A: Fixed Withdrawal Rate (`FIXED_RATE`)
* **Objective**: Test a specific withdrawal rate (e.g., `3.5%`, `4.0%`, `5.0%`) and determine portfolio longevity.
* **Mechanism**:
  1. Computes initial annual retirement withdrawal at the FIRE date:
     $$\text{Withdrawal}_{\text{annual}} = \text{Portfolio Value}_{\text{FIRE}} \times \left( \frac{\text{Withdrawal Rate}}{100} \right)$$
  2. Increases monthly withdrawals by monthly inflation ($1 + r_{\text{inflation, monthly}}$).
  3. Simulates monthly compounding and withdrawals over a 60-year horizon until portfolio depletion or horizon completion.

### Mode B: Fixed Horizon Planning (`FIXED_HORIZON`)
* **Objective**: Solve for the exact sustainable withdrawal rate over a chosen retirement duration (e.g., 30 or 40 years) using the **Real Annuity Formula**:

  $$PMT = PV \times \frac{r_{\text{real}} (1 + r_{\text{real}})^n}{(1 + r_{\text{real}})^n - 1}$$

  Where $PV$ is projected valuation at retirement, $n = \text{Years} \times 12$, and $r_{\text{real}}$ is the monthly Fisher real return:
  $$r_{\text{real}} = \frac{1 + r_{\text{monthly, return}}}{1 + r_{\text{monthly, inflation}}} - 1$$
  *(When $r_{\text{real}} = 0$, $PMT = PV / n$.)*

---

## ⏳ 3. Two-Phase Simulation Mechanics

1. **Phase 1 — Accumulation**: Adds monthly contributions and applies monthly compound returns while tracking out-of-pocket **Principal** separately from **Accumulated Gains**.
2. **Phase 2 — Decumulation**: Stops contributions and draws inflation-adjusted monthly withdrawals pro-rata from accumulated capital until horizon end or depletion.

---

## 🏡 4. Lifestyle Analysis & Purchasing Power Protection

1. **Future Expense Inflation**: Projects your current monthly expenses to your target FIRE date:
   $$\text{Future Expense} = \text{Current Expense} \times (1 + r_{\text{inflation}})^{\text{Years to FIRE}}$$
2. **Current Lifestyle Survival**: Calculates how many years your projected nest egg sustains your inflation-adjusted current lifestyle.
3. **Sustainable Monthly Income**: Reports the baseline real monthly income supported across your horizon.

---

## 📊 5. Visual Projections & Annual Breakdown Table

* **Stacked Trajectory Chart**: Plots **Principal**, **Investment Gains**, and **Annual Withdrawals**, highlighting the crossover point where compounding gains outpace contributions.
* **Annual Cash-Flow Schedule**: Year-by-year table showing Calendar Year, Phase (`Accumulation` / `Retirement`), Remaining Principal, Accumulated Gains, Total Portfolio Value, and Annual Withdrawal.
