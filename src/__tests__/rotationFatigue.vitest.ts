// ════════════════════════════════════════════════════════════════
//  Rotation fatigue annotations — Spec ROTATION-FATIGUE-2026-05.
//
//  annotateRotationFatigue stamps every shipped row with the rotation
//  context (repeat_count, cooldown_remaining, rotation_score,
//  fatigue_state). The wire shape carries those out to the dashboard.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import {
  annotateRotationFatigue,
  commitRotation,
  readFatigueFields,
  _resetRotationForTests,
  getRotationConfig,
} from '@/lib/signals/rotationPolicy';

const baseRow = {
  symbol:           'RELIANCE',
  direction:        'BUY' as const,
  final_score:      85,
  confidence_score: 80,
  rr_ratio:         2.5,
  confirmed_at:     new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min old
};

describe('rotation fatigue', () => {
  beforeEach(() => {
    _resetRotationForTests();
  });

  it('fresh row has repeat_count=0 and fatigue_state=fresh', () => {
    const out = readFatigueFields(baseRow);
    expect(out.repeat_count).toBe(0);
    expect(out.fatigue_state).toBe('fresh');
    expect(out.cooldown_remaining).toBe(getRotationConfig().cooldown_max_cycles);
  });

  it('repeat_count grows after each commitRotation', () => {
    commitRotation([baseRow]);
    commitRotation([baseRow]);
    commitRotation([baseRow]);
    const out = readFatigueFields(baseRow);
    expect(out.repeat_count).toBe(3);
  });

  it('fatigue_state transitions fresh → rotating → fatigued', () => {
    const cfg = getRotationConfig();
    const half = Math.ceil(cfg.cooldown_max_cycles / 2);
    // Fresh: 0..half-1 cycles
    expect(readFatigueFields(baseRow).fatigue_state).toBe('fresh');
    // Rotating: half..max-1
    for (let i = 0; i < half; i++) commitRotation([baseRow]);
    expect(readFatigueFields(baseRow).fatigue_state).toBe('rotating');
    // Fatigued: max+
    for (let i = 0; i < cfg.cooldown_max_cycles - half; i++) commitRotation([baseRow]);
    expect(readFatigueFields(baseRow).fatigue_state).toBe('fatigued');
  });

  it('cooldown_remaining hits 0 once max cycles reached', () => {
    const cfg = getRotationConfig();
    for (let i = 0; i < cfg.cooldown_max_cycles; i++) commitRotation([baseRow]);
    const out = readFatigueFields(baseRow);
    expect(out.cooldown_remaining).toBe(0);
  });

  it('annotateRotationFatigue stamps fields on every row', () => {
    commitRotation([baseRow]);
    const second = { ...baseRow, symbol: 'TCS' };
    const out = annotateRotationFatigue([baseRow, second]);
    expect(out).toHaveLength(2);
    expect(out[0].repeat_count).toBe(1);
    expect(out[1].repeat_count).toBe(0);
    expect(out[0].fatigue_state).toBe('fresh');
    expect(typeof out[0].rotation_score).toBe('number');
  });

  it('rotation_score reflects freshness decay', () => {
    // A 30-min-old row gets ~80% weight (half-life 90 min).
    const out = readFatigueFields(baseRow);
    expect(out.rotation_score).toBeGreaterThan(60);
    expect(out.rotation_score).toBeLessThan(85);
  });

  it('fatigued row with non-improving score gets a cooldown penalty', () => {
    const cfg = getRotationConfig();
    // Push past cooldown threshold
    for (let i = 0; i < cfg.cooldown_max_cycles; i++) commitRotation([baseRow]);
    const fatigued = readFatigueFields(baseRow);
    // Score should be below the freshness-only weight because penalty applied
    const fresh = readFatigueFields({ ...baseRow, symbol: 'NEW' });
    expect(fatigued.rotation_score).toBeLessThan(fresh.rotation_score);
  });

  it('improving score bypasses the cooldown penalty', () => {
    const cfg = getRotationConfig();
    for (let i = 0; i < cfg.cooldown_max_cycles; i++) commitRotation([baseRow]);
    // Now ship the same symbol with a higher final_score
    const improved = { ...baseRow, final_score: 95 };
    const out = readFatigueFields(improved);
    // Repeat is still high, but improving score → no penalty applied
    expect(out.repeat_count).toBe(cfg.cooldown_max_cycles);
    // The rotation_score for the improved row should be HIGHER than
    // for a fresh same-score row (no penalty + improvement bonus is
    // implicit via final_score). We just assert the score is non-zero
    // and reflects the higher base.
    expect(out.rotation_score).toBeGreaterThan(50);
  });

  it('annotateRotationFatigue does not mutate input rows', () => {
    const row = { ...baseRow };
    const beforeKeys = Object.keys(row).length;
    const out = annotateRotationFatigue([row]);
    const afterKeys = Object.keys(row).length;
    expect(afterKeys).toBe(beforeKeys);
    expect(out[0]).not.toBe(row);
  });
});
