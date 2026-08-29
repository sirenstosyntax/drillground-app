"use strict";

// IMPORTANT: the whole module is wrapped in an IIFE.
//
// The app loads these as classic <script> tags, which share ONE global lexical
// scope — so a top-level `const` here would collide with the same name in
// another module and the second file would die silently before defining
// anything. entitlements.js, recommend-drills.js and tailboard.js are wrapped
// the same way; a regression test loads them all into one shared context.
(function () {
"use strict";

// Purchases — turning a Play purchase into the entitlement state that
// entitlements.js already reads.
//
// entitlements.js decides what an entitlement MEANS. This decides how one is
// obtained. The split matters: entitlements.js is pure and has no idea a store
// exists, and nothing here should teach it.
//
// Everything is injected. There is no reference to `window`, `fetch`,
// `localStorage` or PaymentRequest in the logic below — the browser binding at
// the bottom supplies those. That is what lets the whole flow be tested in node
// with no browser and no network, which is the only way any of this gets
// exercised at all: the container cannot build an .aab and CI has no phone.
//
// See engineering/briefs/DRILLGROUND-EB-0210.md.

// The Play payment method. Chrome routes a PaymentRequest naming this to the
// Play Billing code inside the TWA wrapper.
var BILLING_METHOD = "https://play.google.com/billing";

// One Play SKU unlocks every support pack. This string must match the in-app
// product id in Play Console EXACTLY; a typo is a purchase flow that opens
// and then fails with an unhelpful store error. Managed (non-consumable),
// not a subscription. The retired SKUs drillground.resource_packs.v1 and
// drillground.promotion_prep_packs.v1 must not be asked for.
var SUPPORT_PACKS_SKU = "drillground.packs.v1";
var SKUS = {
  support_packs: SUPPORT_PACKS_SKU,
};

function areaForSku(sku) {
  for (var area in SKUS) {
    if (Object.prototype.hasOwnProperty.call(SKUS, area) && SKUS[area] === sku) {
      return area;
    }
  }
  return null;
}

function skuForArea(area) {
  return Object.prototype.hasOwnProperty.call(SKUS, area) ? SKUS[area] : null;
}

// ---------------------------------------------------------------------------
// ACKNOWLEDGEMENT — READ THIS BEFORE CHARGING ANYBODY.
//
// Google Play refunds a purchase that is not acknowledged within three days.
// Nothing in the UI looks wrong while that happens; the money simply reverses.
//
// Verified against source rather than remembered (2026-08-16):
//
//   - Digital Goods API v2.1 (Chrome M102+) exposes getDetails, listPurchases,
//     listPurchaseHistory and consume. It has NO acknowledge(). The v1.0
//     acknowledge(token, purchaseType) was removed in v2.0.
//   - android-browser-helper's ConsumeCall maps consume() to
//     BillingClient.consumeAsync() — which CONSUMES the purchase and makes it
//     buyable again. For a permanent unlock that is precisely wrong: it would
//     revoke the thing the user paid for, and listPurchases() would stop
//     returning it.
//   - android-browser-helper's PaymentActivity does NOT acknowledge on a
//     successful flow. It returns the purchase token and finishes.
//   - Its legacy AcknowledgeCall still exists on the Android side and
//     acknowledges without consuming when makeAvailableAgain is false, but it
//     is documented as "kept around for legacy reasons" and Chrome's v2.1 JS
//     surface does not expose it.
//
// So on a current Chrome there is no verified client-side path to acknowledge a
// NON-CONSUMABLE purchase from the page. Hence:
//
//   1. We never call consume() for these products. Doing so would revoke them.
//   2. We call acknowledge() only if the running browser actually offers it
//      (older Digital Goods surface), which is a real possibility on the wide
//      range of Chrome versions in the field and costs nothing to support.
//   3. When neither exists we do NOT pretend the purchase is settled. The
//      result carries acknowledged:false and a reason, so the caller can log,
//      warn, or refuse to go live.
//
// The remaining honest options, neither of which belongs in this file:
//   - acknowledge server-side with the Play Developer API
//     (purchases.products.acknowledge), which means a backend and a service
//     account — infrastructure monetization.md deliberately avoids; or
//   - confirm on a real device that a purchase made this way is settled
//     without any client call, which is the only way to rule the problem out.
//
// Internal testers can buy. Acknowledge when the browser offers it; never
// consume(). A missing acknowledge API is still a Play-side risk (refund
// after three days) — do not pretend the page settled the charge.
// ---------------------------------------------------------------------------
function acknowledgePurchase(service, purchaseToken) {
  if (!service || !purchaseToken) {
    return Promise.resolve({ acknowledged: false, reason: "no-purchase-token" });
  }
  // Older Digital Goods surface. `false` = acknowledge without making the item
  // available again, i.e. keep the unlock.
  if (typeof service.acknowledge === "function") {
    return Promise.resolve()
      .then(function () {
        return service.acknowledge(purchaseToken, "onetime");
      })
      .then(function () {
        return { acknowledged: true, via: "acknowledge" };
      })
      .catch(function (err) {
        return {
          acknowledged: false,
          reason: "acknowledge-failed",
          error: String((err && err.message) || err),
        };
      });
  }
  // Deliberately NOT falling back to consume(). See the block above.
  return Promise.resolve({
    acknowledged: false,
    reason: "no-acknowledge-api",
  });
}

/**
 * Build the purchase API over injected collaborators.
 *
 * @param {object} deps
 * @param {function} deps.getService   () => Promise<service|null>
 * @param {function} deps.readEntitlements  () => object
 * @param {function} deps.writeEntitlements (object) => void
 * @param {function} deps.startPayment (sku) => Promise<{purchaseToken, complete}>
 * @param {function} [deps.onUnlock]   (area) => void — fetch the paid payload
 * @param {function} [deps.warn]       (message, detail) => void
 */
function createPurchases(deps) {
  var d = deps || {};
  var warn = d.warn || function () {};

  function service() {
    if (typeof d.getService !== "function") return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return d.getService(); })
      .catch(function () {
        // Not being in a TWA is the common case, not an error: the same page is
        // a free website in an ordinary browser tab. Nothing to report.
        return null;
      });
  }

  /** Is a store reachable at all? False in any ordinary browser tab. */
  function available() {
    return service().then(function (s) { return !!s; });
  }

  /**
   * Localised title and price for an area, straight from Play — never a
   * hardcoded number, because the store charges in the user's currency and the
   * page has no idea what that is.
   */
  function detailsFor(area) {
    var sku = skuForArea(area);
    if (!sku) return Promise.resolve(null);
    return service().then(function (s) {
      if (!s || typeof s.getDetails !== "function") return null;
      return Promise.resolve()
        .then(function () { return s.getDetails([sku]); })
        .then(function (items) {
          var found = (items || []).filter(function (i) { return i && i.itemId === sku; });
          return found.length ? found[0] : null;
        })
        .catch(function () { return null; });
    });
  }

  function grant(area) {
    var key = area === "support_packs" ? "support_packs" : area;
    // One SKU grants the one unlock. Ignore retired area names as purchase
    // targets; restore/buy only write support_packs.
    if (key !== "support_packs") return false;
    var stored = d.readEntitlements ? d.readEntitlements() : {};
    var next = {};
    for (var k in stored) {
      if (Object.prototype.hasOwnProperty.call(stored, k)) next[k] = stored[k];
    }
    if (next.support_packs === true) return false; // already held; nothing to write
    next.support_packs = true;
    if (d.writeEntitlements) d.writeEntitlements(next);
    if (d.onUnlock) d.onUnlock("support_packs");
    return true;
  }

  /**
   * What this Google account already owns.
   *
   * This is the whole restore story on Android — reinstall, or a second device
   * signed into the same account, and the unlock comes back with no account of
   * ours and no server. Everywhere else there is nothing to restore from, which
   * is a known and deliberate hole; see EB-0210.
   */
  function restore() {
    return service().then(function (s) {
      if (!s || typeof s.listPurchases !== "function") return [];
      return Promise.resolve()
        .then(function () { return s.listPurchases(); })
        .then(function (purchases) {
          var granted = [];
          (purchases || []).forEach(function (p) {
            var area = p && areaForSku(p.itemId);
            if (area && grant(area)) granted.push(area);
          });
          return granted;
        })
        .catch(function (err) {
          warn("could not list existing purchases", err);
          return [];
        });
    });
  }

  /**
   * Buy one area.
   *
   * Resolves with an outcome rather than rejecting, because every failure here
   * is ordinary: no store, user dismissed the sheet, payment declined. The
   * caller renders a message; nothing throws.
   */
  function buy(area) {
    var sku = skuForArea(area);
    if (!sku) return Promise.resolve({ ok: false, reason: "unknown-area" });
    if (typeof d.startPayment !== "function") {
      return Promise.resolve({ ok: false, reason: "no-payment-support" });
    }
    return service().then(function (s) {
      if (!s) return { ok: false, reason: "no-store" };
      return Promise.resolve()
        .then(function () { return d.startPayment(sku); })
        .then(function (result) {
          var token = result && result.purchaseToken;
          if (!token) return { ok: false, reason: "no-purchase-token" };
          // Grant BEFORE acknowledging. The user has paid; an acknowledgement
          // problem is ours to chase, and must never look to them like the
          // purchase failed.
          grant(area);
          return acknowledgePurchase(s, token).then(function (ack) {
            if (!ack.acknowledged) {
              // Loud on purpose. Play reverses an unacknowledged purchase after
              // three days and nothing else in the app will ever mention it.
              warn("purchase not acknowledged — Play may refund it in 3 days", ack);
            }
            var complete = result && result.complete;
            return Promise.resolve()
              .then(function () {
                if (typeof complete === "function") return complete("success");
              })
              .catch(function () {})
              .then(function () {
                return { ok: true, area: area, acknowledged: !!ack.acknowledged, ack: ack };
              });
          });
        })
        .catch(function (err) {
          return {
            ok: false,
            reason: "payment-failed",
            error: String((err && err.message) || err),
          };
        });
    });
  }

  return {
    available: available,
    detailsFor: detailsFor,
    restore: restore,
    buy: buy,
  };
}

var API = {
  BILLING_METHOD: BILLING_METHOD,
  SUPPORT_PACKS_SKU: SUPPORT_PACKS_SKU,
  SKUS: SKUS,
  areaForSku: areaForSku,
  skuForArea: skuForArea,
  acknowledgePurchase: acknowledgePurchase,
  createPurchases: createPurchases,
};

// --- Browser binding -------------------------------------------------------
// The only place real browser APIs are touched. Feature detection is the whole
// gate: window.getDigitalGoodsService is undefined outside a TWA, so the same
// deployed page is a purchasable app on a phone and a free website everywhere
// else, with no build split.
if (typeof window !== "undefined") {
  API.browserDeps = function (entitlementsApi, onUnlock) {
    return {
      getService: function () {
        if (typeof window.getDigitalGoodsService !== "function") return null;
        return window.getDigitalGoodsService(BILLING_METHOD);
      },
      readEntitlements: function () {
        try {
          return entitlementsApi.parseEntitlements(
            window.localStorage.getItem(entitlementsApi.STORAGE_KEY)
          );
        } catch (e) {
          return {};
        }
      },
      writeEntitlements: function (next) {
        try {
          window.localStorage.setItem(entitlementsApi.STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
          // Private mode or a full quota. The purchase still stands with Play,
          // and restore() recovers it on the next launch.
        }
      },
      startPayment: function (sku) {
        if (typeof window.PaymentRequest !== "function") {
          return Promise.reject(new Error("PaymentRequest unavailable"));
        }
        // The amount is a required placeholder: Play charges the price set in
        // Console, not anything named here.
        var request = new window.PaymentRequest(
          [{ supportedMethods: BILLING_METHOD, data: { sku: sku } }],
          { total: { label: "Total", amount: { currency: "USD", value: "0" } } }
        );
        return request.show().then(function (response) {
          return {
            purchaseToken: response && response.details && response.details.purchaseToken,
            complete: function (status) { return response.complete(status); },
          };
        });
      },
      onUnlock: onUnlock,
      warn: function (message, detail) {
        if (window.console && window.console.warn) {
          window.console.warn("[drillground/purchase] " + message, detail);
        }
      },
    };
  };
}

if (typeof module === "object" && module.exports) {
  module.exports = API;
} else if (typeof self !== "undefined") {
  self.DrillGroundPurchase = API;
}

})();
