"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. recommend-drills.js and tailboard.js are wrapped the same way; a
// regression test loads them all into one shared context. See tailboard.js for
// the full story.
(function () {
"use strict";

// Entitlements — what the user has unlocked.
//
// EVERY DRILL IS FREE. All 87 of them, unabridged, including the promotion-prep
// study material and the specialty categories. Nothing in the drill library is
// gated and nothing here can gate it — see docs/monetization.md.
//
// What is sold is the CONVENIENCE of not assembling the material. Almost every
// drill opens by telling the user to build something first: thirty condition
// cards, a friction-loss key, a twenty-photo placard deck, a blind-timeline
// template. A firefighter who wants to build their own is welcome to, and the
// drill tells them exactly how. The resource packs are for the ones who would
// rather start the reps. See docs/resource-packs-design.md.
//
// Pure by design: no DOM, no fetch. The store lives in localStorage, read and
// written by the app; this module only decides what an entitlement state means.

var STORAGE_KEY = "drillground.entitlements.v1";

// The paid areas the app knows about. A name here is something that CAN be
// gated; whether it IS gated right now is GATE_OPEN below.
//
// Both are MATERIAL, not drills. `promotion_prep` used to appear here and gated
// the promotion-prep drills themselves; it is gone, because those drills are now
// free like every other. What replaced it is `promotion_prep_packs` — the study
// material for that track, kept as its own area because monetization.md's
// sharpest pricing finding is that a promotion candidate's willingness to pay is
// an order of magnitude higher than a drill buyer's ("competes with a salary
// increase"). That insight survives the pivot; it just attaches to the material
// instead of to the drills.
//
// Areas are independent on purpose. Each is its own one-time purchase, and a
// later recurring product would be a THIRD name here rather than a change to how
// these two behave — which is why monetization.md can defer the subscription
// question without blocking anything.
var PAID_AREAS = ["resource_packs", "promotion_prep_packs"];

// ---------------------------------------------------------------------------
// THE STUB.
//
// There is no store and no payment path yet, so the gate is held OPEN: every
// paid area behaves as unlocked, which is the vision's "free while you have no
// audience" stance. This is deliberately a single, obvious constant.
//
// When DrillGround is in an app store and the in-app purchases exist, flip this
// to false and hasEntitlement starts consulting the stored (store-receipt-derived)
// state instead. Nothing else in the resource packs, the previews, or the progress
// display has to change — that is the whole reason the structure is built now
// rather than with the paywall.
//
// It cannot be enforced client-side regardless: the resource payload is a public
// JSON file. Real enforcement is the store's receipt. This flag decides only what
// the UI shows.
//
// Note what this flag can no longer do: it cannot lock a drill. Closing the gate
// withholds assembled material and nothing else, so even a fully gated build
// leaves every drill runnable.
// ---------------------------------------------------------------------------
var GATE_OPEN = true;

function isPaidArea(name) {
  return PAID_AREAS.indexOf(name) !== -1;
}

/**
 * Does the user have this entitlement?
 *
 * @param {string} name        e.g. "promotion_prep"
 * @param {object} [stored]     the parsed entitlements object (from localStorage)
 * @returns {boolean}
 */
function hasEntitlement(name, stored) {
  if (!isPaidArea(name)) return true; // unknown area = not gated = always allowed
  if (GATE_OPEN) return true; // the stub: everything is free today
  return !!(stored && stored[name] === true);
}

/** Parse the stored entitlements safely. Never throws. */
function parseEntitlements(raw) {
  try {
    var parsed = JSON.parse(raw || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    return {};
  }
}

var API = {
  STORAGE_KEY: STORAGE_KEY,
  PAID_AREAS: PAID_AREAS,
  GATE_OPEN: GATE_OPEN,
  isPaidArea: isPaidArea,
  hasEntitlement: hasEntitlement,
  parseEntitlements: parseEntitlements,
};

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundEntitlements = API;
}

})();
