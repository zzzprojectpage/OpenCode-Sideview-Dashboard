// Per-model split of an OpenCode Go cap window.
//
// The Go usage API reports only a window total (for example "1% used"); it does not
// attribute usage to models. OpenCode's own local session statistics do record tokens
// and cost per model for any time range, so the split here is the provider's total
// distributed by each Go model's share of locally recorded cost.
//
// That makes every number here an ESTIMATE with two limits that are surfaced in the UI:
// only usage recorded by this OpenCode installation is visible, and the provider remains
// the authority on the window total.
export const WINDOW_MS = {
  fiveHour: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export const GO_PROVIDER = 'opencode-go';

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function windowStart(windowKey, resetIso) {
  const duration = WINDOW_MS[windowKey];
  if (!duration || typeof resetIso !== 'string') return null;
  const end = Date.parse(resetIso);
  return Number.isFinite(end) ? end - duration : null;
}

function tokenTotal(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  return number(tokens.input) + number(tokens.output) + number(tokens.reasoning)
    + number(cache.read) + number(cache.write);
}

export function splitWindow(models, totalPercent, {provider = GO_PROVIDER} = {}) {
  const goModels = (Array.isArray(models) ? models : []).filter(entry => entry?.model?.providerID === provider);
  if (goModels.length === 0) {
    return {rows: [], basis: null, unattributedPercent: null, note: 'No OpenCode Go usage recorded in this window'};
  }

  const grouped = new Map();
  for (const entry of goModels) {
    const key = `${entry.model.providerID}/${entry.model.id}`;
    const row = grouped.get(key) || {
      id: entry.model.id,
      providerID: entry.model.providerID,
      steps: 0, tokens: 0, cost: 0, billable: false, sharePercent: null,
    };
    row.steps += number(entry.steps);
    row.tokens += tokenTotal(entry.tokens);
    row.cost += number(entry.cost);
    grouped.set(key, row);
  }
  const rows = [...grouped.values()].map(row => ({...row, billable: row.cost > 0}))
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);

  const billedCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const hasTotal = typeof totalPercent === 'number' && Number.isFinite(totalPercent);

  if (billedCost <= 0) {
    return {
      rows, basis: null, unattributedPercent: null,
      note: 'No billable usage recorded in this window, so the total cannot be split',
    };
  }
  if (!hasTotal) {
    return {
      rows, basis: 'cost', unattributedPercent: null,
      note: 'Window total unavailable, so shares of it cannot be estimated',
    };
  }

  for (const row of rows) row.sharePercent = row.cost / billedCost * totalPercent;
  return {rows, basis: 'cost', unattributedPercent: 0, note: null};
}
