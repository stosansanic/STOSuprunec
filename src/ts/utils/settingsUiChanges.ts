type SettingRecord = Record<string, unknown>;
/** Shared projection excludes API keys, Nova Poshta internals and token history. */
export const SETTINGS_REALTIME_COLUMNS = [
  'setting_id', 'data', 'Загальні', 'procent',
  'Приймальник', 'Слюсар', 'Запчастист', 'Складовщик',
] as const;
export type SettingsUiChange = "ignore" | "reconcile" | "changed";

const GLOBAL_ACT_SETTINGS = new Set([1, 2, 3, 5]);
const has = (record: SettingRecord | undefined, key: string): boolean =>
  !!record && Object.prototype.hasOwnProperty.call(record, key);

/**
 * Compare only values consumed by the act/role UI. Realtime UPDATE may contain
 * only the primary key in `old`; its full `new` record is NOT a changed-fields
 * list. In particular novaposhta/API/token/date must never invalidate this UI.
 */
export function createSettingsUiChangeTracker(role: string | null) {
  const baseline = new Map<number, Record<string, boolean>>();
  let revision = 0;

  function project(record: SettingRecord): Record<string, boolean> {
    const values: Record<string, boolean> = {};
    if (GLOBAL_ACT_SETTINGS.has(Number(record.setting_id)) && has(record, "data")) {
      values.data = Boolean(record.data);
    }
    if (role && role !== "Адміністратор" && has(record, role)) {
      values[role] = Boolean(record[role]);
    }
    return values;
  }

  return {
    get revision() { return revision; },
    seed(record: SettingRecord): void {
      const id = Number(record.setting_id);
      if (!Number.isSafeInteger(id) || id < 1) return;
      baseline.set(id, { ...baseline.get(id), ...project(record) });
    },
    inspect(payload: {
      eventType?: string;
      new?: SettingRecord;
      old?: SettingRecord;
    }): SettingsUiChange {
      if (payload.eventType !== "INSERT" && payload.eventType !== "UPDATE" && payload.eventType !== "DELETE") return "ignore";
      const record = payload.eventType === "DELETE" ? payload.old : payload.new;
      const id = Number(record?.setting_id);
      if (!record || !Number.isSafeInteger(id) || id < 1) return "ignore";

      if (payload.eventType === "DELETE") {
        const known = baseline.get(id);
        baseline.delete(id);
        revision++;
        // Deletions can revoke a permission even with a primary-key-only old row.
        return GLOBAL_ACT_SETTINGS.has(id) || (role && role !== "Адміністратор") || (known && Object.keys(known).length)
          ? "reconcile" : "ignore";
      }

      const next = project(record);
      const previous = { ...baseline.get(id), ...project(payload.old || {}) };
      const keys = Object.keys(next);
      if (!keys.length) return "ignore";
      let unknown = false;
      let changed = false;
      for (const key of keys) {
        if (!has(previous, key)) unknown = true;
        else if (previous[key] !== next[key]) changed = true;
      }
      baseline.set(id, { ...baseline.get(id), ...next });
      revision++;
      if (changed) return "changed";
      // A first unseen row is reconciled silently once, never announced as an
      // administrator edit merely because a technical field was updated.
      return unknown ? "reconcile" : "ignore";
    },
  };
}
