"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. recommend-drills.js, tailboard.js and entitlements.js are wrapped
// the same way; a regression test loads them all into one shared context. See
// tailboard.js for the full story.
(function () {
"use strict";

// Resource packs — the material a drill NAMES but does not SHIP. The card deck,
// the case study, the worksheet, the reference card, the image deck, the floor
// plan. See docs/resource-packs-design.md.
//
// Pure by design: no DOM, no fetch. The app does the fetching and hands the
// parsed files in; this module only decides what a pack means and what the user
// is allowed to see of it.
//
// THE POINT OF THE PACKS. Every drill is free — all 87. What is sold is the work
// of assembling what the drills tell you to build: a thirty-card mayday deck, a
// friction-loss key, a twenty-photo placard deck and its ERG answer key, a
// blind-timeline template. A firefighter who would rather build their own is
// welcome to, and the drill says how. A pack removes prep and never removes the
// drill.

// Two pack entitlements. Promotion-prep material is priced separately because a
// promotion candidate's willingness to pay is an order of magnitude higher than a
// drill buyer's — see docs/monetization.md. Both gate MATERIAL; neither can gate a
// drill.
var PAID_AREAS = ["resource_packs", "promotion_prep_packs"];
var DEFAULT_PAID_AREA = "resource_packs";

// Component kinds, in the order the app renders them. Reference material before
// the thing you practice with, and the case study before the worksheet you fill
// in from it — a user opening a pack should be able to read straight down.
var KIND_ORDER = [
  "reference_card",
  "case_study",
  "card_deck",
  "scenario_set",
  "image_deck",
  "floor_plan",
  "worksheet",
];

var KIND_LABELS = {
  card_deck: "Card deck",
  image_deck: "Image deck",
  case_study: "Case study",
  worksheet: "Worksheet",
  scenario_set: "Scenario set",
  reference_card: "Reference card",
  floor_plan: "Floor plan",
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Which entitlement gates this pack. Absent means the general area. */
function packPaidArea(pack) {
  if (!isPlainObject(pack)) return DEFAULT_PAID_AREA;
  return PAID_AREAS.indexOf(pack.paid_area) === -1 ? DEFAULT_PAID_AREA : pack.paid_area;
}

// Callers pass a predicate rather than a boolean because a pack's gate depends on
// WHICH area it belongs to, and the app holds one entitlement map for both.
function entitledFn(isEntitled) {
  if (typeof isEntitled === "function") return isEntitled;
  // Tolerate a plain boolean so a caller with a single-area view still works.
  return function () {
    return !!isEntitled;
  };
}

/** Display label for a component kind. Unknown kinds degrade to the raw value. */
function kindLabel(kind) {
  return KIND_LABELS[kind] || String(kind || "");
}

/**
 * Index the published resource file by drill id.
 *
 * @param {object} published  parsed drill_resources.published.json
 * @returns {object} drillId -> pack (free packs whole, paid packs as previews)
 */
function indexPacks(published) {
  var out = {};
  var packs = (published && published.packs) || [];
  for (var i = 0; i < packs.length; i++) {
    var p = packs[i];
    if (isPlainObject(p) && typeof p.drill_id === "string") out[p.drill_id] = p;
  }
  return out;
}

/**
 * Fold the unlocked payload over the index, replacing previews with the real
 * packs. Called only after the entitlement is granted and the payload fetched.
 *
 * Returns a NEW index rather than mutating, so a failed or partial fetch cannot
 * leave the app holding half-upgraded state.
 *
 * @param {object} index     from indexPacks
 * @param {object} unlocked  parsed drill_resources.unlocked.json
 */
function applyUnlocked(index, unlocked) {
  var merged = {};
  var key;
  for (key in index) {
    if (Object.prototype.hasOwnProperty.call(index, key)) merged[key] = index[key];
  }
  var packs = (unlocked && unlocked.packs) || [];
  for (var i = 0; i < packs.length; i++) {
    var p = packs[i];
    // Only ever replace a pack we already knew about as a preview. An unlocked
    // file naming a drill the published file does not is a build mismatch, and
    // silently accepting it would let the payload introduce content that never
    // passed through the published manifest.
    if (isPlainObject(p) && typeof p.drill_id === "string" && index[p.drill_id]) {
      merged[p.drill_id] = p;
    }
  }
  return merged;
}

/**
 * The pack for a drill, or null.
 *
 * @param {object} index   from indexPacks / applyUnlocked
 * @param {string} drillId
 */
function packForDrill(index, drillId) {
  if (!index || typeof drillId !== "string") return null;
  return Object.prototype.hasOwnProperty.call(index, drillId) ? index[drillId] : null;
}

/**
 * Is this pack withheld from the user?
 *
 * A free pack is never locked. A paid pack is locked unless the user holds the
 * entitlement for ITS area AND the payload has actually been folded in — a pack
 * the user has paid for but whose content has not downloaded yet still has nothing
 * to show, and pretending otherwise would render an empty pack.
 *
 * @param {object} pack
 * @param {function|boolean} isEntitled  (area) => boolean
 */
function isLocked(pack, isEntitled) {
  if (!isPlainObject(pack)) return false;
  if (pack.tier === "free") return false;
  if (!entitledFn(isEntitled)(packPaidArea(pack))) return true;
  return !hasContent(pack);
}

/** Does this pack actually carry renderable content, as opposed to a preview? */
function hasContent(pack) {
  if (!isPlainObject(pack)) return false;
  var comps = pack.components;
  if (!Array.isArray(comps) || comps.length === 0) return false;
  for (var i = 0; i < comps.length; i++) {
    if (isPlainObject(comps[i]) && Array.isArray(comps[i].items) && comps[i].items.length > 0) {
      return true;
    }
  }
  return false;
}

/** Components in render order. Unknown kinds go last, in their original order. */
function orderedComponents(pack) {
  var comps = (isPlainObject(pack) && pack.components) || [];
  return comps
    .map(function (c, i) {
      var rank = KIND_ORDER.indexOf(c && c.kind);
      return { c: c, rank: rank === -1 ? KIND_ORDER.length : rank, i: i };
    })
    .sort(function (a, b) {
      return a.rank - b.rank || a.i - b.i;
    })
    .map(function (entry) {
      return entry.c;
    });
}

/**
 * How many items are in this pack, whether it is a preview or the real thing.
 * Previews carry item_count precisely so a locked card can say "30 cards" and
 * mean it — that specificity is the strongest argument the preview has.
 */
function itemCount(pack) {
  if (!isPlainObject(pack)) return 0;
  if (typeof pack.item_count === "number") return pack.item_count;
  return ((pack.components || []).reduce(function (n, c) {
    return n + (((c && c.items) || []).length);
  }, 0));
}

/**
 * A one-line summary of what is inside, built from either a preview's `contents`
 * manifest or a real pack's components. Used on cards: "Card deck (30) ·
 * Worksheet (3)".
 */
function contentsSummary(pack) {
  if (!isPlainObject(pack)) return "";
  var parts = [];
  if (Array.isArray(pack.contents)) {
    parts = pack.contents.map(function (c) {
      return kindLabel(c.kind) + " (" + (c.item_count || 0) + ")";
    });
  } else {
    parts = orderedComponents(pack).map(function (c) {
      return kindLabel(c && c.kind) + " (" + (((c && c.items) || []).length) + ")";
    });
  }
  return parts.join(" · ");
}

/**
 * Does this item need an operator render pass before it is a picture?
 *
 * An image item with a synthetic_prompt but no asset_path is a SPEC: the prompt
 * is authored and reviewed, the pixels do not exist yet. The app shows the spec
 * and says so, because a broken image tells the user nothing and a silently
 * omitted item makes the pack look shorter than it is.
 */
function isPendingRender(item) {
  return !!(isPlainObject(item) && item.synthetic_prompt && !item.asset_path);
}

/** Is this item's image AI-generated? Drives the visible synthetic label. */
function isSynthetic(item) {
  return !!(isPlainObject(item) && item.synthetic_prompt);
}

/** Every drill id that has a pack, sorted. */
function drillIdsWithPacks(index) {
  var out = [];
  for (var key in index) {
    if (Object.prototype.hasOwnProperty.call(index, key)) out.push(key);
  }
  return out.sort();
}

/** Counts for the resources overview. */
function summarise(index, isEntitled) {
  var ids = drillIdsWithPacks(index);
  var free = 0;
  var locked = 0;
  var unlockedCount = 0;
  for (var i = 0; i < ids.length; i++) {
    var pack = index[ids[i]];
    if (pack.tier === "free") free++;
    else if (isLocked(pack, isEntitled)) locked++;
    else unlockedCount++;
  }
  return { total: ids.length, free: free, locked: locked, unlocked: unlockedCount };
}

var API = {
  PAID_AREAS: PAID_AREAS,
  DEFAULT_PAID_AREA: DEFAULT_PAID_AREA,
  packPaidArea: packPaidArea,
  KIND_ORDER: KIND_ORDER,
  KIND_LABELS: KIND_LABELS,
  kindLabel: kindLabel,
  indexPacks: indexPacks,
  applyUnlocked: applyUnlocked,
  packForDrill: packForDrill,
  isLocked: isLocked,
  hasContent: hasContent,
  orderedComponents: orderedComponents,
  itemCount: itemCount,
  contentsSummary: contentsSummary,
  isPendingRender: isPendingRender,
  isSynthetic: isSynthetic,
  drillIdsWithPacks: drillIdsWithPacks,
  summarise: summarise,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundResources = API;
}

})();
