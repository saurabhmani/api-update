// ════════════════════════════════════════════════════════════════
//  Regime Change Persistence — Product A Phase 3
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { EnhancedMarketRegime } from '../types/signalEngine.types';
import { REGIME_MODEL_VERSION } from './detectMarketRegime';

let _tableEnsured = false;

export async function ensureRegimeChangeTable(): Promise<void> {
  if (_tableEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_regime_changes (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      previous_label VARCHAR(40) DEFAULT NULL,
      new_label VARCHAR(40) NOT NULL,
      trend_state VARCHAR(20) NOT NULL,
      volatility_state VARCHAR(20) NOT NULL,
      breadth_state VARCHAR(30) NOT NULL,
      liquidity_state VARCHAR(20) NOT NULL,
      transition_state VARCHAR(20) NOT NULL,
      transition_confidence INT NOT NULL DEFAULT 0,
      confirmation_bars INT NOT NULL DEFAULT 0,
      change_reason VARCHAR(120) DEFAULT NULL,
      evidence_json JSON,
      model_version VARCHAR(20) NOT NULL,
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rc_computed (computed_at),
      INDEX idx_rc_label (new_label)
    )
  `);
  _tableEnsured = true;
}

/** Persist a confirmed regime change (no-op when hysteresis.changed=false). */
export async function persistRegimeChange(
  regime: EnhancedMarketRegime,
): Promise<{ persisted: boolean }> {
  if (!regime.hysteresis.changed) return { persisted: false };
  await ensureRegimeChangeTable();
  await db.query(
    `INSERT INTO q365_regime_changes
      (previous_label, new_label, trend_state, volatility_state, breadth_state,
       liquidity_state, transition_state, transition_confidence, confirmation_bars,
       change_reason, evidence_json, model_version, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      regime.hysteresis.previousLabel,
      regime.label,
      regime.dimensions.trend_state,
      regime.dimensions.volatility_state,
      regime.dimensions.breadth_state,
      regime.dimensions.liquidity_state,
      regime.dimensions.transition_state,
      regime.hysteresis.transitionConfidence,
      regime.hysteresis.confirmationBarsHeld,
      regime.hysteresis.changeReason,
      JSON.stringify(regime.evidence),
      regime.modelVersion || REGIME_MODEL_VERSION,
    ],
  );
  return { persisted: true };
}
