// Token Radar — scoring model (radar-2).
//
// One sealed snapshot goes in, one ranked board comes out. The board is built
// from the snapshot's own numbers only: no protocol is ever named in the code,
// and no hand-kept list of "good launches" exists anywhere in this file.
//
// What counts as rankable, in short:
//   * the protocol records no token (no market cap, no CoinGecko id, no symbol),
//   * and it is not a wrapped, staked, bridged or exchange product of a token
//     that already trades — that is the watchlist's own test, applied here to
//     every row, not just to the watchlist.
// Everything on the watchlist is ranked (the watchlist is a floor, never a
// ceiling); rankable pre-token protocols below the watchlist floor are added
// as the early rows the radar exists to surface.
//
// How one protocol is scored (all figures come from the snapshot):
//   base       = tvl_usd * 0.25
//   growth     = change_7d clamped to [-60, +120]
//   growthMult = 1 + (growth / 100) * 0.5
//   maturity   = 0.6 + min(age_days, 1095) / 1095 * 0.4   (unknown age: 365 days)
//   diversify  = 1 + 0.02 * min(chains, 5)
//   implied    = max(1, round(base * growthMult * maturity * diversify))
//
// The file is laid out so the pipeline reads top to bottom: the record types
// and the model constants first, then the small pure helpers (age, the four
// multipliers), then the rankability test, then the farm-plan builders, then
// the board assembly, and finally the snapshot parsing and gate checks that
// main.ts calls. Nothing in here touches the network or the disk.

/** One protocol as the sealed snapshot records it: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The tunable numbers behind the score, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  diversification_per_chain: number;
  diversification_max_chains: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  diversification_per_chain: 0.02,
  diversification_max_chains: 5,
};

/** The model version the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2';

/** How many of the biggest live-token protocols the Live token view shows. */
export const LIVE_ROWS = 24;

/** One farm step: what to do, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    diversification_multiplier: number;
    chains_count: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in the compact shape data.js carries, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  diversification_multiplier: number;
}

/** A protocol that already trades: the board shows the market's own value for it, never a model score. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  pre_token_total: number;
  excluded: { wrapped_staked: number; bridge: number; exchange: number; versioned: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Headline figures for the board: watchlist coverage, row counts, live set. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Thrown when the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `n` into [`lo`, `hi`]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Round to four decimal places, for the model breakdown the dashboard shows. */
function roundTo4dp(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Whole days from `listedAt` to `asOf`, never negative; null when either date
 * is missing or unparseable.
 */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

// ---------------------------------------------------------------------------
// The four multipliers, each a small pure function of the snapshot
// ---------------------------------------------------------------------------

/** The protocol's 7-day change, clamped into the model's growth window. */
function growthPercent(protocol: SnapshotProtocol, model: ModelConstants): number {
  return clamp(finiteNumber(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
}

/** How the clamped growth moves the score: half the weekly move, added to 1. */
function growthMultiplier(growthPct: number, model: ModelConstants): number {
  return 1 + (growthPct / 100) * model.growth_weight;
}

/**
 * How long the protocol has existed moves the score: a fresh protocol starts
 * at the floor and gains up to the full range over `maturity_days`. An
 * unknown age counts as `unknown_age_days`.
 */
function maturityMultiplier(age: number | null, model: ModelConstants): number {
  const days = clamp(age ?? model.unknown_age_days, 0, model.maturity_days);
  return model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
}

/** How many chains the protocol lives on moves the score, capped at +10%. */
function diversificationMultiplier(chainCount: number, model: ModelConstants): number {
  return 1 + model.diversification_per_chain * Math.min(chainCount, model.diversification_max_chains);
}

/** The score's starting point: a quarter of the protocol's TVL. */
function baseValue(protocol: SnapshotProtocol, model: ModelConstants): number {
  return protocol.tvl_usd * model.base_multiple;
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; diversifyMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = growthPercent(protocol, model);
  const growthMult = growthMultiplier(growthPct, model);
  const maturityMult = maturityMultiplier(age, model);
  const diversifyMult = diversificationMultiplier(protocol.chains.length, model);
  const implied = Math.max(1, Math.round(baseValue(protocol, model) * growthMult * maturityMult * diversifyMult));
  return { implied, growthPct, growthMult, maturityMult, diversifyMult, age };
}

// ---------------------------------------------------------------------------
// Rankability: is this protocol still waiting on a launch of its own?
// ---------------------------------------------------------------------------

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
export const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a release number is a pool of another protocol, not a launch of its own. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words in a name that mark a wrapped or staked product of a token that trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** An exchange's name at the start of a protocol's name marks its own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Why a pre-token protocol cannot launch a token of its own, or null when it
 * can. This is the watchlist's own test, applied to every row instead of only
 * the watchlist: a wrapped, staked or bridged product of a token that already
 * trades is not a protocol still waiting on a launch.
 */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'already has a token';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return 'exchange product';
  if (VERSIONED_NAME.test(p.name)) return 'versioned pool';
  return null;
}

/** Whether the board may rank this protocol: pre-token and not a wrapped, staked or bridged product of a token that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

// ---------------------------------------------------------------------------
// Farm plans: seven steps derived from the protocol's own record
// ---------------------------------------------------------------------------

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

// Category rules are tables, not nested branches: the first rule whose
// keywords appear in the lower-cased category wins, and the order below is
// the order that decides. Every rule's wording is the plan's wording, so a
// category's plan follows its category and no two categories share a plan
// by accident.

type ActionRule = {
  keys: string[];
  text: (name: string, chain: string, capital: number) => string;
};

/** The opening action, by category. */
const ACTION_RULES: ActionRule[] = [
  { keys: ['lend', 'cdp', 'collateral'], text: (name, chain, capital) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.` },
  { keys: ['dex', 'yield', 'leveraged farm', 'liquidity manager'], text: (name, chain, capital) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
  { keys: ['bridge'], text: (name, chain, capital) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.` },
  { keys: ['staking', 'restak'], text: (name, _chain, capital) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.` },
  { keys: ['perpetual', 'derivative', 'basis trading'], text: (name, _chain, capital) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.` },
  { keys: ['prediction'], text: (name, _chain, capital) => `Fund $${capital} and place one market position on ${name}.` },
  { keys: ['curator', 'allocator', 'risk'], text: (name, chain, capital) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.` },
  { keys: ['chain'], text: (_name, chain, capital) => `Bridge $${capital} of USDC to ${chain} and use it in the chain's flagship app.` },
  { keys: ['farm'], text: (name, chain, capital) => `Deposit $${capital} into ${name}'s farm on ${chain} and keep the position open.` },
  { keys: ['stable'], text: (name, chain, capital) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.` },
  { keys: ['rwa'], text: (name, chain, capital) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.` },
  { keys: ['insurance'], text: (name, chain, capital) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.` },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.text(p.name, chain, capital);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

type TextRule = { keys: string[]; text: string };

/** The weekly qualifying action that fits the protocol's category. */
const WEEKLY_RULES: TextRule[] = [
  { keys: ['lend', 'cdp', 'collateral'], text: 'a small borrow or a top-up of the supply position' },
  { keys: ['dex', 'yield', 'leveraged farm', 'liquidity manager'], text: 'a small swap or a top-up of the liquidity position' },
  { keys: ['perpetual', 'derivative', 'basis trading'], text: 'one small trade or a margin top-up' },
  { keys: ['prediction'], text: 'one market position' },
  { keys: ['curator', 'allocator', 'risk'], text: 'a small extra deposit or a rebalance vote' },
  { keys: ['rwa'], text: 'a small mint or a holding check on the yield asset' },
  { keys: ['governance'], text: 'one governance vote' },
];

/** The weekly action for this category, or the generic one when no rule fits. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.text;
  }
  return 'a deposit, a swap or a vote';
}

/** The main risk of this category, in plain words. */
const RISK_RULES: TextRule[] = [
  { keys: ['lend', 'cdp', 'collateral'], text: 'a sharp price move can liquidate a borrow, so keep the position well collateralised' },
  { keys: ['perpetual', 'derivative', 'basis trading', 'leveraged'], text: 'leverage cuts both ways, so the hedge stays small and the margin stays funded' },
  { keys: ['dex', 'yield', 'liquidity manager'], text: 'a volatile pair can lose value to impermanent loss, so check the pair before adding more' },
  { keys: ['bridge'], text: 'a bridge holds funds on two chains, so bridge only what the position needs' },
  { keys: ['rwa'], text: 'a real-world asset depends on its issuer, so read who backs it before minting more' },
  { keys: ['stable'], text: 'a stable asset can depeg, so watch its peg before adding funds' },
];

/** The risk for this category, or the generic one when no rule fits. */
function riskFor(p: SnapshotProtocol): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of RISK_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.text;
  }
  return 'a smart-contract bug can freeze funds, so farm only what you can afford to lose';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a
 * time. The plan is derived from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names: the opening
 * action, the weekly action and the risk all follow the category.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const opening = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: opening,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week: ${weeklyActionFor(p)}.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Check whether ${p.name} runs a points or rewards program, and confirm the position counts toward it before the next snapshot.`,
      cost: 'no fee to check',
      time: '10 minutes',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Know the risk first: ${riskFor(p)}.`,
      cost: 'nothing to check, and never pay for a guarantee',
      time: '10 minutes',
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.`,
      cost: 'no fee to check, and never pay to claim',
      time: '15 minutes',
    },
  ];
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

/** The snapshot's protocols keyed by slug, for the watchlist lookup. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((protocol) => [protocol.slug, protocol]));
}

/** Strongest first; ties break on the slug so the order is deterministic. */
function byImpliedDesc(
  a: { implied: number; p: SnapshotProtocol },
  b: { implied: number; p: SnapshotProtocol },
): number {
  if (b.implied !== a.implied) return b.implied - a.implied;
  return a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, even one the
  // snapshot no longer carries (it cannot, but the board's coverage is the
  // gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: EVERY rankable pre-token protocol below the watchlist
  // floor, not a capped sample of them. The floor is where the house's
  // reading started, not where this one stops, so a protocol below it is
  // ranked on the same terms as a watchlist row. Never a replacement for a
  // watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols.filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd);
  for (const found of early) chosen.set(found.slug, found);

  const scored = [...chosen.values()].map((p) => {
    const score = impliedValue(p, snapshot.as_of, model);
    return { p, ...score };
  });
  scored.sort(byImpliedDesc);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: roundTo4dp(s.growthMult),
      maturity_multiplier: roundTo4dp(s.maturityMult),
      diversification_multiplier: roundTo4dp(s.diversifyMult),
      chains_count: s.p.chains.length,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: watchlist.has(row.slug),
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    diversification_multiplier: row.model.diversification_multiplier,
  };
}

// Which "set aside" bucket one exclusion reason belongs to. The dashboard
// shows the counts instead of hiding them, so a reader can see exactly what
// the strict rule left out and why.
const EXCLUSION_BUCKETS: Array<{ reasons: string[]; bucket: 'wrapped_staked' | 'bridge' | 'exchange' | 'versioned' }> = [
  { reasons: ['category Bridge', 'category Canonical Bridge'], bucket: 'bridge' },
  { reasons: ['category Liquid Staking', 'category Liquid Restaking', 'category Restaked BTC', 'wrapped or staked product'], bucket: 'wrapped_staked' },
  { reasons: ['category CEX', 'exchange product'], bucket: 'exchange' },
  { reasons: ['versioned pool'], bucket: 'versioned' },
];

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((row) => !watchlist.has(row.slug)).length;
  // What was set aside, and why: every pre-token record the strict rule leaves out, by reason.
  const excluded = { wrapped_staked: 0, bridge: 0, exchange: 0, versioned: 0 };
  let preTokenTotal = 0;
  for (const p of snapshot.protocols) {
    if (!isPreToken(p)) continue;
    preTokenTotal++;
    const reason = exclusionReason(p);
    if (reason === null) continue;
    const bucket = EXCLUSION_BUCKETS.find((entry) => entry.reasons.includes(reason));
    if (bucket !== undefined) excluded[bucket.bucket]++;
  }
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    pre_token_total: preTokenTotal,
    excluded,
    rows: board.map((row) => radarRow(row, watchlist)),
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------------------
// Snapshot parsing, gate checks, and the dashboard script
// ---------------------------------------------------------------------------

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
