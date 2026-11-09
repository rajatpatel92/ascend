# FIRE Calculator

The **FIRE (Financial Independence, Retire Early) Calculator** is a retirement projection and decumulation simulation engine located at `/analysis/fire`.

Unlike simplistic static calculators that multiply annual spending by 25 (the classical "4% rule"), Ascend provides an actuarial two-phase simulation modeling monthly compounding, inflation-adjusted spending, lifestyle sustainability, and dual analytical modes.

---

## ⚙️ 1. Core Model Parameters

| Parameter | Description | Default |
| :--- | :--- | :--- |
| **Current Portfolio Value** | Automatically imported from your live portfolio net worth and converted to your active base currency. | Live Net Worth |
| **Target FIRE Date** | The exact target Year and Month when contributions cease and decumulation begins. | Today + 10 Years |
| **Monthly Contribution** | Planned ongoing monthly savings deposited into the portfolio during the accumulation phase. | $2,000 |
| **Expected Annual Return (%)** | Nominal annualized compound investment growth rate. | 7.0% |
| **Inflation Rate (%)** | Annual compound inflation rate applied to future living expenses and retirement withdrawals. | 2.5% |
| **Current Monthly Expenses** | Current baseline living costs, utilized to conduct the **Lifestyle Analysis**. | $2,000 |

---

## 🔀 2. Dual Simulation Modes

Ascend features two mathematical modes tailored to different planning questions:

```
Mode 1: FIXED_RATE    ──> "I want to withdraw 4%. How many years will my money last?"
Mode 2: FIXED_HORIZON ──> "I plan to be retired for 35 years. What withdrawal rate can I sustain?"
```

---

### Mode A: Fixed Withdrawal Rate (`FIXED_RATE`)
* **Objective**: Test a specific withdrawal rate (e.g., $3.5\%$, $4.0\%$, or $5.0\%$) and determine portfolio longevity.
* **Mechanism**:
  1. Computes the initial annual retirement withdrawal at the retirement date:
     $$\text{Withdrawal}_{\text{annual}} = \text{Portfolio Value}_{\text{FIRE}} \times \left( \frac{\text{Withdrawal Rate}}{100} \right)$$
  2. Each subsequent month in retirement, the withdrawal amount increases by monthly inflation ($1 + r_{\text{inflation, monthly}}$).
  3. Simulates monthly returns and withdrawals over a 60-year horizon until the portfolio is exhausted or reaches the simulation boundary.
  4. Outputs the exact number of years the portfolio survives.

---

### Mode B: Fixed Horizon Planning (`FIXED_HORIZON`)
* **Objective**: Determine the exact sustainable withdrawal rate required to fund retirement for an exact duration (e.g., 30 years, 40 years) without premature exhaustion.
* **Mechanism**:
  Ascend solves for the initial monthly withdrawal $PMT$ using the **Real Annuity Formula**:

  $$PMT = PV \times \frac{r_{\text{real}} (1 + r_{\text{real}})^n}{(1 + r_{\text{real}})^n - 1}$$

  Where:
  * $PV$: Projected portfolio valuation at the target retirement date.
  * $n$: Total months of retirement ($n = \text{Withdrawal Duration in Years} \times 12$).
  * $r_{\text{real}}$: Real monthly compound return, derived using the Fisher relation:
    $$r_{\text{real}} = \frac{1 + r_{\text{monthly, return}}}{1 + r_{\text{monthly, inflation}}} - 1$$
  * When $r_{\text{real}} = 0$, $PMT = \frac{PV}{n}$.

  The system then back-calculates the effective sustainable annual withdrawal rate:
  $$\text{Effective Rate} = \left( \frac{PMT \times 12}{PV} \right) \times 100\%$$

---

## ⏳ 3. Two-Phase Simulation Mechanics

### Phase 1: Accumulation Phase
* Models monthly wealth growth from today until the target retirement month.
* In each month $m$:
  1. Monthly contribution is added to principal.
  2. Compound investment return is calculated:
     $$\text{Interest Earned} = (\text{Total Balance}_{m-1} + \text{Contribution}) \times r_{\text{monthly, return}}$$
  3. Principal and accumulated investment gains are tracked separately to provide visibility into compound interest efficiency.

### Phase 2: Decumulation (Retirement) Phase
* Begins immediately following the accumulation phase.
* Contributions terminate; monthly withdrawals commence.
* Withdrawals are drawn pro-rata from accumulated principal and gains.
* In each month:
  1. The inflation-adjusted withdrawal is subtracted from capital.
  2. Remaining capital earns the monthly investment growth rate.
  3. The withdrawal requirement for the following month is inflated by $(1 + r_{\text{monthly, inflation}})$.

---

## 🏡 4. Lifestyle Analysis & Purchasing Power Protection

Ascend answers the practical question: *"Will my retirement portfolio actually support my current quality of life?"*

1. **Future Expense Inflation**: Projects your current monthly expenses to the target FIRE date:
   $$\text{Future Expense} = \text{Current Expense} \times (1 + r_{\text{inflation}})^{\text{Years to FIRE}}$$
2. **Current Lifestyle Survival**: Calculates how many years the portfolio will survive if you withdraw exactly what is needed to maintain your current lifestyle adjusted for inflation.
3. **Guaranteed Monthly Income**: Calculates the baseline real monthly income provided by the portfolio across the desired horizon.

---

## 📊 5. Visual Projections & Cash-Flow Table

### Stacked Bar Chart
The interactive chart plots your financial trajectory across both phases:
* **Principal (Blue)**: Cumulative out-of-pocket savings invested.
* **Investment Gains (Green)**: Wealth created purely through compound returns.
* **Annual Withdrawals (Red)**: Cash removed to fund living expenses.
* Clearly highlights the cross-over point where investment gains surpass invested principal.

### Detailed Annual Breakdown Table
Provides an annual audit schedule including:
* **Year**: Calendar year.
* **Phase**: Accumulation vs. Retirement.
* **Principal Balance**: Remaining unliquidated principal.
* **Accumulated Gains**: Remaining investment growth.
* **Total Portfolio Value**: Ending balance for the year.
* **Annual Withdrawal**: Total nominal dollars withdrawn that year.
