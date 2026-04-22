import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import type { Signal } from '@/lib/signal-engine/live/analyzeInstrument';

export type AlertTypeKey =
  | 'breakout_confirmed' | 'breakdown_confirmed' | 'strong_momentum_shift'
  | 'unusual_volume_spike' | 'signal_crossed_threshold'
  | 'watchlist_opp_upgraded' | 'trade_setup_triggered' | 'support_resistance_breach';

interface AlertRuleConfig {
  key: AlertTypeKey; enabled: boolean;
  priority: 'high' | 'medium' | 'low';
  cooldown_minutes: number;
  min_confidence: number;
}

// ── Load alert rules from DB ──────────────────────────────────────
async function loadAlertRules(): Promise<AlertRuleConfig[]> {
  const cached = await cacheGet<AlertRuleConfig[]>('alert_rules:active');
  if (cached) return cached;
  try {
    const { rows } = await db.query(`SELECT * FROM alert_rules WHERE enabled=TRUE`);
    if (rows.length) { await cacheSet('alert_rules:active', rows, 300); return rows as AlertRuleConfig[]; }
  } catch {}
  return [
    { key:'breakout_confirmed',      enabled:true, priority:'high',   cooldown_minutes:120, min_confidence:70 },
    { key:'breakdown_confirmed',     enabled:true, priority:'high',   cooldown_minutes:120, min_confidence:70 },
    { key:'strong_momentum_shift',   enabled:true, priority:'medium', cooldown_minutes:60,  min_confidence:60 },
    { key:'unusual_volume_spike',    enabled:true, priority:'medium', cooldown_minutes:60,  min_confidence:55 },
    { key:'signal_crossed_threshold',enabled:true, priority:'medium', cooldown_minutes:30,  min_confidence:65 },
    { key:'watchlist_opp_upgraded',  enabled:true, priority:'low',    cooldown_minutes:90,  min_confidence:60 },
    { key:'trade_setup_triggered',   enabled:true, priority:'high',   cooldown_minutes:60,  min_confidence:70 },
    { key:'support_resistance_breach',enabled:true,priority:'medium', cooldown_minutes:120, min_confidence:60 },
  ];
}

// ── Deduplicate: check if same alert recently sent ────────────────
async function isDuplicate(userId: number, typeKey: string, instrumentKey: string | null, cooldownMin: number): Promise<boolean> {
  const redisKey = `alert_dup:${userId}:${typeKey}:${instrumentKey ?? 'global'}`;
  const exists   = await cacheGet(redisKey);
  return !!exists;
}

async function markSent(userId: number, typeKey: string, instrumentKey: string | null, cooldownMin: number): Promise<void> {
  const redisKey = `alert_dup:${userId}:${typeKey}:${instrumentKey ?? 'global'}`;
  await cacheSet(redisKey, 1, cooldownMin * 60);
}

// ── Per-user daily cap ────────────────────────────────────────────
async function checkDailyCap(userId: number): Promise<boolean> {
  const today    = new Date().toISOString().split('T')[0];
  const key      = `alerts:daily:${userId}:${today}`;
  const count    = (await cacheGet<number>(key)) ?? 0;

  // Get user alert_mode
  const { rows } = await db.query(`SELECT alert_mode FROM user_preferences WHERE user_id=?`, [userId]);
  const mode = rows[0]?.alert_mode ?? 'instant';

  const caps: Record<string, number> = { instant: 50, digest: 10, limited: 5 };
  return count < (caps[mode] ?? 50);
}

async function incrementDailyCount(userId: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const key   = `alerts:daily:${userId}:${today}`;
  const now   = new Date(); const midnight = new Date(now); midnight.setHours(24,0,0,0);
  const ttl   = Math.floor((midnight.getTime()-now.getTime())/1000);
  const current = (await cacheGet<number>(key)) ?? 0;
  await cacheSet(key, current+1, ttl);
}

// ── Dispatch a single alert to a user ────────────────────────────
export async function dispatchAlert(
  userId:        number,
  typeKey:       AlertTypeKey,
  title:         string,
  message:       string,
  instrumentKey: string | null,
  tradingsymbol: string | null,
  priority:      'high' | 'medium' | 'low' = 'medium',
  cooldownMin:   number = 60
): Promise<boolean> {
  if (await isDuplicate(userId, typeKey, instrumentKey, cooldownMin)) return false;
  if (!(await checkDailyCap(userId))) return false;

  await db.query(`
    INSERT INTO alert_events
      (user_id, instrument_key, tradingsymbol, alert_type, alert_type_key, title, message, priority, is_read, delivered_at)
    VALUES (?,?,?,?,?,?,?,?,FALSE,NOW())
  `, [userId, instrumentKey, tradingsymbol, typeKey, title, message, priority]);

  await markSent(userId, typeKey, instrumentKey, cooldownMin);
  await incrementDailyCount(userId);
  return true;
}

// ── Generate alerts from a signal ────────────────────────────────
export async function generateAlertsFromSignal(signal: Signal): Promise<void> {
  const rules = await loadAlertRules();

  if (signal.confidence < 50) return;

  // Get all users who have this instrument in their watchlist
  const { rows: userRows } = await db.query(`
    SELECT DISTINCT w.user_id
    FROM watchlist_items wi
    JOIN watchlists w ON w.id = wi.watchlist_id
    WHERE wi.instrument_key = ?
  `, [signal.instrument_key]);

  for (const { user_id } of userRows) {
    for (const rule of rules) {
      if (!rule.enabled || signal.confidence < rule.min_confidence) continue;

      let shouldAlert = false;
      let title = '', message = '';

      switch (rule.key) {
        case 'breakout_confirmed':
          if (signal.direction === 'BUY' && signal.confidence >= 70) {
            shouldAlert = true;
            title   = `${signal.tradingsymbol} Breakout Signal`;
            message = `BUY signal at ₹${signal.entry_price} with ${signal.confidence}% confidence. ${signal.reasons[0]?.text ?? ''}`;
          }
          break;
        case 'breakdown_confirmed':
          if (signal.direction === 'SELL' && signal.confidence >= 70) {
            shouldAlert = true;
            title   = `${signal.tradingsymbol} Breakdown Signal`;
            message = `SELL signal at ₹${signal.entry_price} with ${signal.confidence}% confidence.`;
          }
          break;
        case 'signal_crossed_threshold':
          if (signal.opportunity_score >= 75) {
            shouldAlert = true;
            title   = `${signal.tradingsymbol} High Opportunity Score`;
            message = `Opportunity score reached ${signal.opportunity_score}/100. ${signal.direction} signal active.`;
          }
          break;
        case 'watchlist_opp_upgraded':
          if (signal.opportunity_score >= 70) {
            shouldAlert = true;
            title   = `${signal.tradingsymbol} now in top opportunities`;
            message = `Score: ${signal.opportunity_score}/100 · ${signal.direction} · ${signal.risk} Risk`;
          }
          break;
        case 'strong_momentum_shift':
          if (signal.confidence >= 65) {
            const momentumReason = signal.reasons.find(r => r.factor_key === 'momentum_pct' || r.factor_key === 'breakout_level');
            if (momentumReason) {
              shouldAlert = true;
              title   = `${signal.tradingsymbol} Momentum Shift`;
              message = momentumReason.text;
            }
          }
          break;
      }

      if (shouldAlert) {
        await dispatchAlert(user_id, rule.key, title, message, signal.instrument_key, signal.tradingsymbol, rule.priority, rule.cooldown_minutes);
      }
    }
  }
}

// ── Alert when a setup is triggered ──────────────────────────────
export async function alertSetupTriggered(userId: number, tradingsymbol: string, instrumentKey: string, setupId: number): Promise<void> {
  await dispatchAlert(
    userId, 'trade_setup_triggered',
    `${tradingsymbol} Trade Setup Triggered`,
    `Your ${tradingsymbol} setup has been triggered. Review entry and SL levels.`,
    instrumentKey, tradingsymbol, 'high', 60
  );
}
