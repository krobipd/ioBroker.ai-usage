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
    /**
     * Links a device to the state that says whether it is up. THIS is what puts the
     * connection icon next to the device in the admin's object tree — the object
     * browser reads `common.statusStates` and nothing else (verified in
     * adapter-react-v5 `renderLeaf.tsx`). A relative id is expanded to
     * `<device>.<id>`. `offlineId` is inverted: true means offline.
     */
    statusStates?: { onlineId?: string; offlineId?: string; errorId?: string };
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
 * The account's own device object is NOT part of this — the poll engine's skeleton
 * owns it, together with the link that draws the connection icon. Building it here
 * as well would mean two definitions of one object, and the one without the link
 * would be the one that silently wins after a cache reset.
 *
 * @param accountId the id-safe account id (device node)
 * @param snapshot the fetched snapshot
 * @returns objects (parents first) and state writes
 */
export function mapSnapshot(accountId: string, snapshot: UsageSnapshot): TreeResult {
  const objects: ObjectDef[] = [];
  const writes: StateWrite[] = [];
  const add = (pair: { def: ObjectDef; write: StateWrite }): void => {
    objects.push(pair.def);
    writes.push(pair.write);
  };
  const channel = (id: string, name: string): void => {
    objects.push({ id, type: "channel", common: { name } });
  };

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
      // resetAt is a FIXED part of every window, not an optional extra. Providers
      // omit the timestamp whenever no window is currently running (Anthropic
      // sends it as null right after a reset) — treating that as "capability
      // gone" deleted the datapoint mid-throttle and re-created it after the
      // next use (krobi, live 2026-09-01). The datapoint stays; an empty string
      // says "no running window", because keeping the OLD date would be a lie.
      add(
        state(
          `${accountId}.limits.${windowId}.resetAt`,
          `${limit.label} resets at`,
          "string",
          "date",
          limit.resetAt ?? "",
        ),
      );
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
    if (credits.resetCredits !== undefined) {
      add(
        state(
          `${accountId}.credits.resetCredits`,
          "Available limit-reset credits",
          "number",
          "value",
          credits.resetCredits,
        ),
      );
      // Companion timestamp — same fixed-part rule as limits.*.resetAt: always
      // present next to the count, empty while no voucher is held.
      add(
        state(
          `${accountId}.credits.resetCreditsNextExpiry`,
          "Next reset credit expires at",
          "string",
          "date",
          credits.resetCreditsNextExpiry ?? "",
        ),
      );
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
 * Windows marked `scoped` cover a single model and are left out as long as a
 * plan-wide window exists — a model the user never touches may sit at 100 %
 * permanently and would pin the account's warning on forever. Their datapoints
 * still exist; they just do not speak for the account.
 *
 * When an account has ONLY model windows (Google reports no plan-wide bucket at
 * all), the fullest of them speaks instead — an account whose warning could never
 * fire would be no better than one whose warning never clears. The label carries
 * the model name, so the warning says which model it came from.
 *
 * @param snapshot the snapshot
 * @returns percent plus the label that produced it, or undefined when nothing applies
 */
export function limitingWindow(snapshot: UsageSnapshot): { percent: number; label: string } | undefined {
  const limits = snapshot.limits ?? [];
  const planWide = limits.filter(limit => !limit.scoped);
  let best: { percent: number; label: string } | undefined;
  for (const limit of planWide.length > 0 ? planWide : limits) {
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
 * What has to be deleted after a snapshot no longer carries STRUCTURE it used to.
 *
 * ioBroker never removes an object on its own: a limit window that a provider stops
 * reporting, or a model that got renamed, would sit in the tree frozen on its last
 * percentage and keep saying it forever. So every round compares what the account
 * delivers now against what it had — but only STRUCTURE goes: a whole
 * `limits.<window>` or `models.<model>` subtree whose window/model the answer no
 * longer carries at all.
 *
 * A single VALUE inside a still-delivered window never counts as an orphan.
 * Providers omit optional fields depending on the account's momentary state
 * (Anthropic drops the reset timestamp while no window runs) — deleting on that
 * removed the datapoint mid-throttle and re-created it after the next use (krobi,
 * live 2026-09-01; the same class of bug as homeconnect's childLock). Datapoints
 * never come and go with the provider's mood: once created they stay until their
 * whole window/model/account goes, and time-stamp companions are actively written
 * empty instead of being dropped.
 *
 * Channels come after their states, deepest first, so a parent is never deleted
 * before its children.
 *
 * @param known every state id the account had before (relative to the instance)
 * @param current the state ids this snapshot delivers
 * @param keep the static state ids of the skeleton, which never expire
 * @returns object ids to delete, children before parents
 */
export function orphanObjectIds(
  known: readonly string[],
  current: readonly string[],
  keep: readonly string[],
): string[] {
  const surviving = new Set([...current, ...keep]);
  // The subtrees whose members the answer still delivers — a state inside one of
  // them survives even when its own id was not written this round.
  const livingSubtrees = new Set<string>();
  for (const id of current) {
    const parts = id.split(".");
    // <account>.limits.<window>.<state> / <account>.models.<model>.<state>
    if (parts.length >= 4 && (parts[1] === "limits" || parts[1] === "models")) {
      livingSubtrees.add(parts.slice(0, 3).join("."));
    }
  }
  const goneStates = known.filter(id => {
    if (surviving.has(id)) {
      return false;
    }
    const parts = id.split(".");
    if (parts.length >= 4 && (parts[1] === "limits" || parts[1] === "models")) {
      // Structure: gone only when the whole window/model fell out of the answer.
      return !livingSubtrees.has(parts.slice(0, 3).join("."));
    }
    // Everything outside those subtrees (credits/costs/tokens values, available)
    // stays once created — a provider that stops a field mid-life leaves a frozen
    // value, which is the smaller harm than a datapoint that comes and goes.
    return false;
  });
  const emptyChannels = new Set<string>();
  const remaining = new Set([...surviving, ...known.filter(id => !goneStates.includes(id))]);
  for (const id of goneStates) {
    const parts = id.split(".");
    // Walk up from the state's own channel; the account node itself (one segment)
    // belongs to the skeleton and is never touched here.
    for (let depth = parts.length - 1; depth >= 2; depth--) {
      const parent = parts.slice(0, depth).join(".");
      if (![...remaining].some(alive => alive.startsWith(`${parent}.`))) {
        emptyChannels.add(parent);
      }
    }
  }
  return [...goneStates, ...[...emptyChannels].sort((a, b) => b.split(".").length - a.split(".").length)];
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
