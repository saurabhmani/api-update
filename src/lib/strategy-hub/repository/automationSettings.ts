import { db } from '@/lib/db';
import { ensureStrategyHubTables } from './strategyHubSchema';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationSettings,
} from '../operations/types';

export async function loadAutomationSettings(): Promise<AutomationSettings> {
  await ensureStrategyHubTables();
  try {
    const { rows } = await db.query<{ settings_json: unknown; updated_by: string | null; updated_at: string }>(
      `SELECT settings_json, updated_by, updated_at FROM strategy_hub_automation_settings ORDER BY id DESC LIMIT 1`,
    );
    const row = rows?.[0];
    if (!row) return { ...DEFAULT_AUTOMATION_SETTINGS };
    const parsed = typeof row.settings_json === 'object'
      ? row.settings_json as Partial<AutomationSettings>
      : JSON.parse(String(row.settings_json)) as Partial<AutomationSettings>;
    return {
      ...DEFAULT_AUTOMATION_SETTINGS,
      ...parsed,
      updatedAt: new Date(row.updated_at).toISOString(),
      updatedBy: row.updated_by,
    };
  } catch {
    return { ...DEFAULT_AUTOMATION_SETTINGS };
  }
}

export async function saveAutomationSettings(
  patch: Partial<AutomationSettings>,
  actor: string,
): Promise<AutomationSettings> {
  await ensureStrategyHubTables();
  const current = await loadAutomationSettings();
  const next: AutomationSettings = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM strategy_hub_automation_settings ORDER BY id DESC LIMIT 1`,
  );
  if (rows?.[0]?.id) {
    await db.query(
      `UPDATE strategy_hub_automation_settings SET settings_json = ?, updated_by = ? WHERE id = ?`,
      [JSON.stringify(next), actor, rows[0].id],
    );
  } else {
    await db.query(
      `INSERT INTO strategy_hub_automation_settings (settings_json, updated_by) VALUES (?, ?)`,
      [JSON.stringify(next), actor],
    );
  }
  return next;
}
