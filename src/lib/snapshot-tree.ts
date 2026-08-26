import type { UsageSnapshot } from "./provider";
import { sanitizeId } from "./pure-helpers";

/** An object to create: id (relative to the instance), type and common. */
export interface ObjectDef {
  /** Object id relative to the instance root. */
  id: string;
  /** ioBroker object type. */
  type: "device" | "channel" | "state";
  /** The object's common. */
  common: {
    name: string | Record<string, string>;
    type?: "boolean" | "number" | "string";
    role?: string;
    read?: boolean;
    write?: boolean;
    unit?: string;
    min?: number;
    max?: number;
  };
}

/** A state value to write (ack). */
export interface StateWrite {
  /** State id relative to the instance root. */
  id: string;
  /** The value. */
  value: boolean | number | string;
}

/**
 * A read-only state definition plus its value — the tree builder's working unit.
 *
 * @param id the state id
 * @param name the object name
 * @param type the value type
 * @param role the state role
 * @param value the current value
 * @param unit optional unit
 * @returns the def/value pair
 */
function state(
  id: string,
  name: string,
  type: "boolean" | "number" | "string",
  role: string,
  value: boolean | number | string,
  unit?: string,
): { def: ObjectDef; write: StateWrite } {
  const common: ObjectDef["common"] = { name, type, role, read: true, write: false };
  if (unit !== undefined) {
    common.unit = unit;
  }
  return { def: { id, type: "state", common }, write: { id, value } };
}

/** The result of mapping one snapshot: objects to upsert (parents first) and values to write. */
export interface TreeResult {
  /** Objects in creation order (device, channels, states). */
  objects: ObjectDef[];
  /** State values to write with ack. */
  writes: StateWrite[];
}

/**
 * Map one account snapshot onto the harmonised object tree: `limits.*`, `credits.*`,
 * `costs.*`, `tokens.*` (+ `models.*`) — only what the snapshot carries is created,
 * so the tree mirrors exactly what the provider's source delivers.
 *
 * @param accountId the id-safe account id (device node)
 * @param accountName the display name for the device object
 * @param provider the provider kind (device object name suffix)
 * @param snapshot the fetched snapshot
 * @returns objects (parents first) and state writes
 */
export function mapSnapshot(
  accountId: string,
  accountName: string,
  provider: string,
  snapshot: UsageSnapshot,
): TreeResult {
  const objects: ObjectDef[] = [];
  const writes: StateWrite[] = [];
  const add = (pair: { def: ObjectDef; write: StateWrite }): void => {
    objects.push(pair.def);
    writes.push(pair.write);
  };
  const channel = (id: string, name: string): void => {
    objects.push({ id, type: "channel", common: { name } });
  };

  objects.push({ id: accountId, type: "device", common: { name: `${accountName} (${provider})` } });

  if (snapshot.limits && snapshot.limits.length > 0) {
    channel(`${accountId}.limits`, "Limit windows");
    for (const limit of snapshot.limits) {
      const windowId = sanitizeId(limit.name);
      if (!windowId) {
        continue;
      }
      channel(`${accountId}.limits.${windowId}`, limit.label);
      add(
        state(`${accountId}.limits.${windowId}.percent`, `${limit.label} used`, "number", "value", limit.percent, "%"),
      );
      if (limit.resetAt !== undefined) {
        add(
          state(`${accountId}.limits.${windowId}.resetAt`, `${limit.label} resets at`, "string", "date", limit.resetAt),
        );
      }
    }
  }

  const credits = snapshot.credits;
  if (credits) {
    channel(`${accountId}.credits`, "Credits");
    const unit = credits.pieces ? "" : credits.currency;
    if (credits.used !== undefined) {
      add(state(`${accountId}.credits.used`, "Credits used", "number", "value", credits.used, unit));
    }
    if (credits.limit !== undefined) {
      add(state(`${accountId}.credits.limit`, "Credits limit", "number", "value", credits.limit, unit));
    }
    if (credits.remaining !== undefined) {
      add(state(`${accountId}.credits.remaining`, "Credits remaining", "number", "value", credits.remaining, unit));
    }
    if (credits.percent !== undefined) {
      add(state(`${accountId}.credits.percent`, "Credits used (percent)", "number", "value", credits.percent, "%"));
    }
    if (credits.granted !== undefined) {
      add(state(`${accountId}.credits.granted`, "Granted balance", "number", "value", credits.granted, unit));
    }
    if (credits.toppedUp !== undefined) {
      add(state(`${accountId}.credits.toppedUp`, "Topped-up balance", "number", "value", credits.toppedUp, unit));
    }
  }

  const costs = snapshot.costs;
  if (costs) {
    channel(`${accountId}.costs`, "Costs");
    if (costs.today !== undefined) {
      add(state(`${accountId}.costs.today`, "Costs today", "number", "value", costs.today, costs.currency));
    }
    if (costs.month !== undefined) {
      add(state(`${accountId}.costs.month`, "Costs this month", "number", "value", costs.month, costs.currency));
    }
    if (costs.total !== undefined) {
      add(state(`${accountId}.costs.total`, "Costs total (lifetime)", "number", "value", costs.total, costs.currency));
    }
    if (costs.projectedMonth !== undefined) {
      add(
        state(
          `${accountId}.costs.projectedMonth`,
          "Costs projected month-end (computed)",
          "number",
          "value",
          costs.projectedMonth,
          costs.currency,
        ),
      );
    }
  }

  const tokens = snapshot.tokens;
  if (tokens) {
    channel(`${accountId}.tokens`, "Tokens");
    if (tokens.inputToday !== undefined) {
      add(state(`${accountId}.tokens.inputToday`, "Input tokens today", "number", "value", tokens.inputToday));
    }
    if (tokens.outputToday !== undefined) {
      add(state(`${accountId}.tokens.outputToday`, "Output tokens today", "number", "value", tokens.outputToday));
    }
    if (tokens.perModel && tokens.perModel.length > 0) {
      channel(`${accountId}.models`, "Per-model usage");
      for (const model of tokens.perModel) {
        const modelId = sanitizeId(model.model);
        if (!modelId) {
          continue;
        }
        channel(`${accountId}.models.${modelId}`, model.model);
        if (model.tokens !== undefined) {
          add(
            state(
              `${accountId}.models.${modelId}.tokensToday`,
              `${model.model} tokens today`,
              "number",
              "value",
              model.tokens,
            ),
          );
        }
        if (model.cost !== undefined) {
          add(
            state(
              `${accountId}.models.${modelId}.costToday`,
              `${model.model} costs today`,
              "number",
              "value",
              model.cost,
              snapshot.costs?.currency ?? "USD",
            ),
          );
        }
      }
    }
  }

  if (snapshot.available !== undefined) {
    add(state(`${accountId}.available`, "Balance sufficient for calls", "boolean", "indicator", snapshot.available));
  }

  return { objects, writes };
}

/**
 * The window that decides how full an account is: the highest PLAN-WIDE limit, or
 * the granted budget when the account has no windows at all.
 *
 * Windows marked `scoped` are left out on purpose — they cover a single model and
 * may sit at 100 % permanently for a model the user never touches, which would
 * pin the account's warning on forever. Their datapoints still exist; they just
 * do not speak for the account.
 *
 * @param snapshot the snapshot
 * @returns percent plus the label that produced it, or undefined when nothing applies
 */
export function limitingWindow(snapshot: UsageSnapshot): { percent: number; label: string } | undefined {
  let best: { percent: number; label: string } | undefined;
  for (const limit of snapshot.limits ?? []) {
    if (limit.scoped) {
      continue;
    }
    if (!best || limit.percent > best.percent) {
      best = { percent: limit.percent, label: limit.label };
    }
  }
  const credits = snapshot.credits?.percent;
  if (credits !== undefined && (!best || credits > best.percent)) {
    best = { percent: credits, label: "Credits" };
  }
  return best;
}

/**
 * The highest plan-wide limit percent in a snapshot, or undefined when it has none.
 *
 * @param snapshot the snapshot
 * @returns the maximum percent
 */
export function maxLimitPercent(snapshot: UsageSnapshot): number | undefined {
  return limitingWindow(snapshot)?.percent;
}
