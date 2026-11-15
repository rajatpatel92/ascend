import test from 'node:test';
import assert from 'node:assert/strict';
import {
    allocateTradeAcrossAccounts,
    buildEqualWeightTargets,
    classifyAccountTaxStatus,
    computeCategoryRebalancePlan,
    seedCategoryTargetsFromHoldings,
    simulateGlideStep,
    validateGlidePathSchedule,
    type CategoryTargetConfig
} from './rebalance-extensions.ts';
import type { RebalanceItem, TargetConfig } from './rebalance-planner.ts';

test('classifyAccountTaxStatus maps Canadian, US, Indian, and Taxable account types', () => {
    assert.equal(classifyAccountTaxStatus('TFSA'), 'TAX_FREE');
    assert.equal(classifyAccountTaxStatus('Roth IRA'), 'TAX_FREE');
    assert.equal(classifyAccountTaxStatus('RRSP'), 'TAX_DEFERRED');
    assert.equal(classifyAccountTaxStatus('401(k)'), 'TAX_DEFERRED');
    assert.equal(classifyAccountTaxStatus('Non-Registered'), 'TAXABLE');
    assert.equal(classifyAccountTaxStatus('Brokerage'), 'TAXABLE');
    assert.equal(classifyAccountTaxStatus('Unassigned'), 'TAXABLE');
});

test('allocateTradeAcrossAccounts prioritizes Tax-Free then Tax-Deferred before Taxable sells', () => {
    const accounts = [
        { accountId: '1', accountName: 'My Taxable', accountType: 'Non-Registered', platformName: 'Questrade', quantity: 50, value: 5000 },
        { accountId: '2', accountName: 'My TFSA', accountType: 'TFSA', platformName: 'Wealthsimple', quantity: 30, value: 3000 },
        { accountId: '3', accountName: 'My RRSP', accountType: 'RRSP', platformName: 'Questrade', quantity: 20, value: 2000 }
    ];

    // Sell $2,500 -> entirely inside TFSA, no taxable warning
    const tfsaOnlySell = allocateTradeAcrossAccounts(accounts, 'SELL', 2500, 25, false);
    assert.equal(tfsaOnlySell.hasTaxableSellWarning, false);
    assert.match(tfsaOnlySell.primaryVenueLabel || '', /My TFSA/);
    assert.equal(tfsaOnlySell.allocations[0].suggestedAction, 'SELL');
    assert.equal(tfsaOnlySell.allocations[0].suggestedValue, 2500);
    assert.equal(tfsaOnlySell.allocations[2].suggestedAction, 'HOLD');

    // Sell $6,000 -> exhausts TFSA ($3,000) + RRSP ($2,000) + spills $1,000 into Non-Registered -> triggers warning
    const spillToTaxable = allocateTradeAcrossAccounts(accounts, 'SELL', 6000, 60, false);
    assert.equal(spillToTaxable.hasTaxableSellWarning, true);
    const taxableAlloc = spillToTaxable.allocations.find((a) => a.accountName === 'My Taxable')!;
    assert.equal(taxableAlloc.suggestedAction, 'SELL');
    assert.equal(taxableAlloc.suggestedValue, 1000);
});

test('computeCategoryRebalancePlan aggregates by investmentType and splits pro-rata across constituents', () => {
    const items: RebalanceItem[] = [
        {
            symbol: 'VFV.TO',
            investmentType: 'ETF',
            currentPercent: 60,
            targetPercent: 0,
            glidePathPercent: null,
            driftPercent: 60,
            currentValue: 6000,
            targetValue: 0,
            driftValue: 6000,
            action: 'SELL',
            actionShares: 60,
            assetPrice: 100,
            assetCurrency: 'CAD'
        },
        {
            symbol: 'XEQT.TO',
            investmentType: 'ETF',
            currentPercent: 20,
            targetPercent: 0,
            glidePathPercent: null,
            driftPercent: 20,
            currentValue: 2000,
            targetValue: 0,
            driftValue: 2000,
            action: 'SELL',
            actionShares: 50,
            assetPrice: 40,
            assetCurrency: 'CAD'
        },
        {
            symbol: 'ZAG.TO',
            investmentType: 'Bond',
            currentPercent: 20,
            targetPercent: 0,
            glidePathPercent: null,
            driftPercent: 20,
            currentValue: 2000,
            targetValue: 0,
            driftValue: 2000,
            action: 'SELL',
            actionShares: 100,
            assetPrice: 20,
            assetCurrency: 'CAD'
        }
    ];

    const categoryTargets: CategoryTargetConfig[] = [
        { investmentType: 'ETF', targetPercentage: 60 },
        { investmentType: 'Bond', targetPercentage: 40 }
    ];

    const result = computeCategoryRebalancePlan(items, categoryTargets, {
        mode: 'FULL',
        newCash: 0,
        tolerancePercent: 1,
        wholeShares: false
    });

    assert.equal(result.rows.length, 2);
    const bond = result.rows.find((r) => r.investmentType === 'Bond')!;
    const etf = result.rows.find((r) => r.investmentType === 'ETF')!;

    assert.equal(bond.currentPercent, 20);
    assert.equal(bond.targetPercent, 40);
    assert.equal(bond.effectiveAction, 'BUY');
    assert.equal(bond.tradeValue, 2000);
    assert.equal(bond.constituents[0].suggestedShares, 100);

    assert.equal(etf.currentPercent, 80);
    assert.equal(etf.effectiveAction, 'SELL');
    assert.equal(etf.tradeValue, 2000);
    // Pro-rata: VFV is 75% of ETF value -> $1,500 (15 shares), XEQT is 25% -> $500 (12.5 shares)
    const vfvSub = etf.constituents.find((c) => c.symbol === 'VFV.TO')!;
    const xeqtSub = etf.constituents.find((c) => c.symbol === 'XEQT.TO')!;
    assert.equal(vfvSub.suggestedValue, 1500);
    assert.equal(vfvSub.suggestedShares, 15);
    assert.equal(xeqtSub.suggestedValue, 500);
    assert.equal(xeqtSub.suggestedShares, 12.5);

    const seeded = seedCategoryTargetsFromHoldings(items);
    assert.equal(seeded[0].investmentType, 'ETF');
    assert.equal(seeded[0].targetPercentage, 80);
    assert.equal(seeded[1].targetPercentage, 20);
});

test('buildEqualWeightTargets produces weights summing exactly to 100.0%', () => {
    const existing: TargetConfig[] = [
        { symbol: 'VFV.TO', targetPercentage: 50, yearlyDriftAdjustment: -1 }
    ];
    const eq = buildEqualWeightTargets(['VFV.TO', 'XEQT.TO', 'ZAG.TO'], existing);
    assert.equal(eq.length, 3);
    assert.equal(eq[0].yearlyDriftAdjustment, -1);
    const sum = Math.round(eq.reduce((s, t) => s + t.targetPercentage, 0) * 10) / 10;
    assert.equal(sum, 100);
});

test('validateGlidePathSchedule and simulateGlideStep check net-zero drift and project +1Y targets', () => {
    const imbalanced: TargetConfig[] = [
        { symbol: 'EQ', targetPercentage: 80, yearlyDriftAdjustment: -1.5, lastAdjustmentDate: '2026-01-15T00:00:00.000Z' },
        { symbol: 'BOND', targetPercentage: 20, yearlyDriftAdjustment: 1.0, lastAdjustmentDate: '2026-01-15T00:00:00.000Z' }
    ];

    const report = validateGlidePathSchedule(imbalanced);
    assert.equal(report.activeCount, 2);
    assert.equal(report.netAnnualDrift, -0.5);
    assert.equal(report.hasNetDriftWarning, true);
    assert.equal(report.lastAdjustedDate, '2026-01-15');
    assert.equal(report.nextAdjustmentDate, '2027-01-15');

    const sim = simulateGlideStep(imbalanced, 1);
    assert.equal(sim.simulatedTargets[0].targetPercentage, 78.5);
    assert.equal(sim.simulatedTargets[1].targetPercentage, 21.0);
    assert.equal(sim.postStepTotal, 99.5);
});
