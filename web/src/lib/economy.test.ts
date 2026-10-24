import { describe, expect, it } from 'vitest';
import {
  adminOverhead,
  contestPoints,
  creditScore,
  emi,
  freightCost,
  itemPrestige,
  netPerDay,
  outputQuality,
  paybackDays,
  personalIncomeTax,
  plotCost,
  rateTier,
  reliability,
  upgradeCost,
  valueCheck,
} from './economy';

describe('netPerDay matches the seed chain', () => {
  it('grain farm earns 914/day', () => {
    const net = netPerDay({
      output: { qty: 100, price: 4.5 },
      inputs: [{ qty: 60, price: 1.2 }, { qty: 20, price: 4 }],
      opCost: 120,
      upkeepPerDay: 100,
    });
    expect(net).toBeCloseTo(914, 6);
  });
  it('flour mill earns 543/day', () => {
    const net = netPerDay({ output: { qty: 80, price: 8 }, inputs: [{ qty: 100, price: 4.5 }], opCost: 70, upkeepPerDay: 100 });
    expect(net).toBeCloseTo(543.2, 6);
  });
  it('bakery earns 1,690/day', () => {
    const net = netPerDay({ output: { qty: 40, price: 27 }, inputs: [{ qty: 80, price: 8 }], opCost: 120, upkeepPerDay: 100 });
    expect(net).toBeCloseTo(1690.4, 6);
  });
  it('farm pays back in about 33 days', () => {
    expect(paybackDays(30_000, 914)).toBeCloseTo(32.8, 1);
    expect(paybackDays(30_000, 0)).toBe(Infinity);
  });
});

describe('progression costs', () => {
  it('mill upgrade to Lv 4 costs 40,000 × 1.12³', () => {
    expect(Math.round(upgradeCost(40_000, 4))).toBe(56_197);
  });
  it('admin overhead starts above 20 levels and caps at +30%', () => {
    expect(adminOverhead(19)).toBe(1);
    expect(adminOverhead(30)).toBeCloseTo(1.06);
    expect(adminOverhead(500)).toBeCloseTo(1.3);
  });
  it('first 12 plots are free, then 5,000 × 1.25^(n−13)', () => {
    expect(plotCost(12)).toBe(0);
    expect(plotCost(13)).toBe(5000);
    expect(plotCost(14)).toBe(6250);
  });
});

describe('quality', () => {
  it('is capped at lowest input + 1', () => {
    expect(outputQuality([0, 4], 3)).toBe(1);
  });
  it('adds research bonus to the mean', () => {
    expect(outputQuality([1, 1], 1)).toBe(2);
    expect(outputQuality([2, 3], 0)).toBe(2);
  });
  it('never exceeds Q5', () => {
    expect(outputQuality([5, 5], 3)).toBe(5);
  });
});

describe('bank', () => {
  // The design report quotes 1,718.65; the formula it gives actually yields 1,718.83.
  it('EMI for 50k at 0.2%/day over 30 days is 1,718.83', () => {
    expect(emi(50_000, 0.002, 30)).toBeCloseTo(1718.83, 2);
  });
  it('zero rate splits principal evenly', () => {
    expect(emi(3000, 0, 30)).toBe(100);
  });
  it('credit score of the design mock is 742', () => {
    expect(creditScore({ repayment: 0.96, lowDebt: 0.55, ageDays: 47, dscr: 1.7, stability: 0.6 })).toBe(742);
  });
  it('maps scores to the right daily rate', () => {
    expect(rateTier(742).dailyRate).toBe(0.0015);
    expect(rateTier(800).dailyRate).toBe(0.001);
    expect(rateTier(300).maxLtv).toBe(0.35);
  });
});

describe('trust and competition', () => {
  it('new companies start at 80 reliability', () => {
    expect(reliability(0, 0)).toBe(80);
  });
  it('perfect delivery approaches 100', () => {
    expect(reliability(1_000_000, 1_000_000)).toBeGreaterThan(99);
  });
  it('contest points cap at 1,500', () => {
    expect(contestPoints(50_000, 50_000)).toBe(1000);
    expect(contestPoints(500_000, 50_000)).toBe(1500);
    expect(contestPoints(10, 0)).toBe(0);
  });
});

describe('designer value check', () => {
  it('rejects prices above inputs × 1.8 + op', () => {
    const r = valueCheck(100, 20, 300);
    expect(r.max).toBe(200);
    expect(r.pass).toBe(false);
    expect(valueCheck(100, 20, 180).pass).toBe(true);
  });
});

describe('personal economy', () => {
  it('income tax is progressive', () => {
    expect(personalIncomeTax(40_000)).toBe(0);
    expect(personalIncomeTax(60_000)).toBeCloseTo(1000);
    expect(personalIncomeTax(600_000)).toBeCloseTo(45_000 + 15_000);
  });
  it('freight counts intra-region as a quarter hop', () => {
    expect(freightCost(1000, 1, 0)).toBe(5);
    expect(freightCost(1000, 1, 2)).toBe(40);
  });
  it('prestige is log-scaled and boosted by rarity', () => {
    expect(itemPrestige(1000)).toBe(0);
    expect(itemPrestige(100_000)).toBeCloseTo(200);
    expect(itemPrestige(100_000, 'unique')).toBeCloseTo(600);
  });
});
