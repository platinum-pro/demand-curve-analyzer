/* Demand Curve Analyzer — model & fitting engine.
   Pure functions, no DOM. Loadable in the browser (window.DCAModel) and in
   Node (module.exports) so the exact same code can be validated against R.

   Model: Koffarnus, Franck, Stein & Bickel (2015) exponentiated demand:
     Q(P) = Q0 * 10^( k * (exp(-alpha * Q0 * P) - 1) )
   k is treated as a fixed property of the measurement instrument (default 2),
   matching the reference R analysis (nls, algorithm = "port",
   bounds alpha in [0, 0.1], Q0 in [0, 100]).
*/
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCAModel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LN10 = Math.LN10;

  function koff(P, alpha, Q0, k) {
    return Q0 * Math.pow(10, k * (Math.exp(-alpha * Q0 * P) - 1));
  }

  function rssOf(points, a, q, k) {
    var s = 0;
    for (var i = 0; i < points.length; i++) {
      var r = points[i].y - koff(points[i].x, a, q, k);
      s += r * r;
    }
    return s;
  }

  /* Levenberg–Marquardt for (alpha, Q0) with k fixed, box constraints via
     clamping, analytic Jacobian. */
  function lm(points, k, a0, q0, bounds) {
    var a = Math.min(Math.max(a0, bounds.aLo), bounds.aHi);
    var q = Math.min(Math.max(q0, Math.max(bounds.qLo, 1e-9)), bounds.qHi);
    var lambda = 1e-3;
    var rss = rssOf(points, a, q, k);
    var converged = false;

    for (var iter = 0; iter < 400; iter++) {
      // Build JtJ (2x2) and Jt r (2)
      var j11 = 0, j12 = 0, j22 = 0, g1 = 0, g2 = 0;
      for (var i = 0; i < points.length; i++) {
        var x = points[i].x, y = points[i].y;
        var E = Math.exp(-a * q * x);
        var f = q * Math.pow(10, k * (E - 1));
        var common = f * k * LN10 * x * E;
        var dfda = -common * q;             // df/dalpha
        var dfdq = f / q - common * a;      // df/dQ0
        var r = y - f;
        j11 += dfda * dfda; j12 += dfda * dfdq; j22 += dfdq * dfdq;
        g1 += dfda * r; g2 += dfdq * r;
      }

      var accepted = false;
      for (var tries = 0; tries < 60; tries++) {
        var d11 = j11 + lambda * (j11 || 1e-12);
        var d22 = j22 + lambda * (j22 || 1e-12);
        var det = d11 * d22 - j12 * j12;
        if (!isFinite(det) || Math.abs(det) < 1e-300) { lambda *= 4; continue; }
        var da = (g1 * d22 - g2 * j12) / det;
        var dq = (g2 * d11 - g1 * j12) / det;
        var aNew = Math.min(Math.max(a + da, bounds.aLo), bounds.aHi);
        var qNew = Math.min(Math.max(q + dq, Math.max(bounds.qLo, 1e-9)), bounds.qHi);
        var rssNew = rssOf(points, aNew, qNew, k);
        if (isFinite(rssNew) && rssNew <= rss) {
          var rel = (rss - rssNew) / (rss + 1e-30);
          var stepA = Math.abs(aNew - a), stepQ = Math.abs(qNew - q);
          a = aNew; q = qNew; rss = rssNew;
          lambda = Math.max(lambda / 3, 1e-12);
          accepted = true;
          if (rel < 1e-13 && stepA < 1e-15 && stepQ < 1e-10) converged = true;
          break;
        }
        lambda *= 4;
      }
      if (!accepted || converged) { converged = converged || !accepted; break; }
    }
    return { alpha: a, Q0: q, rss: rss, converged: converged };
  }

  /* LM over alpha only, Q0 held fixed (used when Q0 is pinned to the
     observed zero-price demand). */
  function lmAlphaOnly(points, k, a0, qFixed, bounds) {
    var a = Math.min(Math.max(a0, bounds.aLo), bounds.aHi);
    var lambda = 1e-3;
    var rss = rssOf(points, a, qFixed, k);
    var converged = false;

    for (var iter = 0; iter < 400; iter++) {
      var j11 = 0, g1 = 0;
      for (var i = 0; i < points.length; i++) {
        var x = points[i].x, y = points[i].y;
        var E = Math.exp(-a * qFixed * x);
        var f = qFixed * Math.pow(10, k * (E - 1));
        var dfda = -f * k * LN10 * x * E * qFixed;
        var r = y - f;
        j11 += dfda * dfda;
        g1 += dfda * r;
      }
      var accepted = false;
      for (var tries = 0; tries < 60; tries++) {
        var d11 = j11 + lambda * (j11 || 1e-12);
        if (!isFinite(d11) || Math.abs(d11) < 1e-300) { lambda *= 4; continue; }
        var da = g1 / d11;
        var aNew = Math.min(Math.max(a + da, bounds.aLo), bounds.aHi);
        var rssNew = rssOf(points, aNew, qFixed, k);
        if (isFinite(rssNew) && rssNew <= rss) {
          var rel = (rss - rssNew) / (rss + 1e-30);
          var stepA = Math.abs(aNew - a);
          a = aNew; rss = rssNew;
          lambda = Math.max(lambda / 3, 1e-12);
          accepted = true;
          if (rel < 1e-13 && stepA < 1e-15) converged = true;
          break;
        }
        lambda *= 4;
      }
      if (!accepted || converged) { converged = converged || !accepted; break; }
    }
    return { alpha: a, Q0: qFixed, rss: rss, converged: converged };
  }

  /* Multi-start fit: coarse grid to seed LM, refine from the best seeds.
     points: [{x, y}] with x >= 0 and finite y (the model is defined at
     price 0, where Q(0) = Q0; callers decide whether to pass a zero-price
     point). opts.fixedQ0 pins Q0 and fits alpha only. */
  function fit(points, k, opts) {
    opts = opts || {};
    var pts = points.filter(function (p) {
      return isFinite(p.x) && p.x >= 0 && isFinite(p.y);
    });
    if (pts.length < 3) return { error: "Need at least 3 valid price points to fit." };

    var maxY = -Infinity, meanY = 0;
    for (var i = 0; i < pts.length; i++) { if (pts[i].y > maxY) maxY = pts[i].y; meanY += pts[i].y; }
    meanY /= pts.length;

    var bounds = {
      aLo: 0,
      aHi: opts.alphaMax != null ? opts.alphaMax : 0.1,
      qLo: 0,
      qHi: opts.q0Max != null ? opts.q0Max : 100
    };

    // Coarse alpha grid (log-spaced) x a few Q0 candidates
    var alphaSeeds = [];
    for (var e = -10; e <= 0; e += 0.5) {
      var av = Math.pow(10, e);
      if (av > 0 && av <= bounds.aHi) alphaSeeds.push(av);
    }
    alphaSeeds.push(1e-7); // the reference R start

    var fixedQ0 = opts.fixedQ0 != null && isFinite(opts.fixedQ0) && opts.fixedQ0 > 0
      ? opts.fixedQ0 : null;

    var qSeeds = fixedQ0 != null ? [fixedQ0] : [
      Math.min(Math.max(maxY, 1e-6), bounds.qHi),
      Math.min(Math.max(maxY * 1.1, 1e-6), bounds.qHi),
      bounds.qHi
    ];

    var seeds = [];
    for (var ai = 0; ai < alphaSeeds.length; ai++) {
      for (var qi = 0; qi < qSeeds.length; qi++) {
        seeds.push({ a: alphaSeeds[ai], q: qSeeds[qi], rss: rssOf(pts, alphaSeeds[ai], qSeeds[qi], k) });
      }
    }
    seeds.sort(function (u, v) { return u.rss - v.rss; });

    var best = null;
    var nStarts = Math.min(6, seeds.length);
    for (var s = 0; s < nStarts; s++) {
      var res = fixedQ0 != null
        ? lmAlphaOnly(pts, k, seeds[s].a, fixedQ0, bounds)
        : lm(pts, k, seeds[s].a, seeds[s].q, bounds);
      if (!best || res.rss < best.rss) best = res;
    }

    var tss = 0;
    for (var t = 0; t < pts.length; t++) tss += (pts[t].y - meanY) * (pts[t].y - meanY);
    var r2 = tss > 0 ? 1 - best.rss / tss : NaN;

    return {
      alpha: best.alpha,
      Q0: best.Q0,
      k: k,
      rss: best.rss,
      rSquared: r2,
      n: pts.length,
      converged: best.converged,
      q0Fixed: fixedQ0 != null
    };
  }

  /* Price at which predicted demand equals `target` (default 50, i.e. P50 for
     percentage data). Closed-form inversion of the model; returns NaN when the
     curve never crosses the target (Q0 at/below target, or the asymptote
     Q0*10^-k sits above it) — mirroring the R script's NA cases. */
  function pAtTarget(alpha, Q0, k, target) {
    if (!(alpha > 0) || !(Q0 > 0) || !(k > 0) || !(target > 0)) return NaN;
    if (Q0 <= target) return NaN;
    var rhs = 1 + Math.log10(target / Q0) / k;
    if (!(rhs > 0)) return NaN;
    return -Math.log(rhs) / (alpha * Q0);
  }

  /* Principal branch of the Lambert W function (Newton iteration); defined
     for x >= -1/e. Used for the exact Pmax solution. */
  function lambertW0(x) {
    if (!isFinite(x) || x < -1 / Math.E) return NaN;
    var w = x < 1 ? x : Math.log(x);
    for (var i = 0; i < 100; i++) {
      var ew = Math.exp(w);
      var next = w - (w * ew - x) / (ew * (1 + w));
      if (!isFinite(next)) return NaN;
      if (Math.abs(next - w) < 1e-13) return next;
      w = next;
    }
    return w;
  }

  /* Pmax: the price at which demand transitions from inelastic to elastic —
     the exact unit-elasticity solution (Gilroy, Kaplan, Reed, Hantula &
     Hursh, 2019): Pmax = -W0(-1 / (k ln 10)) / (alpha * Q0).
     Undefined (NaN) when k <= e/ln10, where demand never reaches unit
     elasticity. */
  function pmax(alpha, Q0, k) {
    if (!(alpha > 0) || !(Q0 > 0) || !(k > 0)) return NaN;
    var w = lambertW0(-1 / (k * Math.LN10));
    if (!isFinite(w)) return NaN;
    return -w / (alpha * Q0);
  }

  /* Area under the curve: a model-free summary of overall demand intensity,
     computed directly from the aggregated data (never the fitted curve).
     Adapts Myerson, Green, & Warusawitharana's (2001) trapezoidal AUC
     method to price data the way Borges, Kuang, Milhorn, & Yi (2016)
     adapted it for delay discounting: demand (y) is normalized to its own
     maximum, as in the original method, but price (x) is normalized on a
     LOG10 scale (min-max between the lowest and highest price tested)
     rather than linearly — HPT price grids are conventionally log-spaced,
     and linear normalization lets the gap between the two highest prices
     dominate the total area (Borges et al.'s own example: two adjacent
     delays contributed 80% and 0.01% of total AUC under linear scaling).
     A price-0 point cannot be log-transformed directly; rather than
     Borges et al.'s fixed "+1" offset (which assumes a fixed, study-
     invariant unit like a day — not true of price, which can be in any
     currency or scale), a tested price-0 point is instead placed at a
     pseudo-position one decade below the lowest positive price — the same
     convention already used to plot price-0 on the main chart — so it is
     included rather than dropped. Bounded [0, 1]. Returns NaN if fewer
     than 2 valid points, or no positive price is present to anchor the
     log scale. */
  function auc(points) {
    var pts = points.filter(function (p) {
      return isFinite(p.x) && p.x >= 0 && isFinite(p.y);
    });
    if (pts.length < 2) return NaN;
    pts = pts.slice().sort(function (a, b) { return a.x - b.x; });
    var minPos = null;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x > 0 && (minPos == null || pts[i].x < minPos)) minPos = pts[i].x;
    }
    if (minPos == null) return NaN;
    var pseudoX = minPos / 10;
    var xs = pts.map(function (p) { return p.x > 0 ? p.x : pseudoX; });
    var lxMin = Math.log10(xs[0]), lxMax = Math.log10(xs[xs.length - 1]);
    var yMax = -Infinity;
    for (var j = 0; j < pts.length; j++) if (pts[j].y > yMax) yMax = pts[j].y;
    if (!(lxMax > lxMin) || !(yMax > 0)) return NaN;
    var area = 0;
    for (var k = 0; k < pts.length - 1; k++) {
      var x1 = (Math.log10(xs[k]) - lxMin) / (lxMax - lxMin);
      var x2 = (Math.log10(xs[k + 1]) - lxMin) / (lxMax - lxMin);
      var y1 = pts[k].y / yMax, y2 = pts[k + 1].y / yMax;
      area += (x2 - x1) * (y1 + y2) / 2;
    }
    return area;
  }

  /* Everything the site reports for one series of aggregated points, in one
     place so the results cards and the bootstrap (which refits resampled
     data) cannot drift apart. pts: [{x, y}] ascending in x; mode is
     "binary" or "quantity"; zeroMode is "exclude" | "include" | "fix". */
  function summarizeSeries(pts, mode, k, zeroMode) {
    var posPts = pts.filter(function (p) { return p.x > 0; });
    var zeroPts = pts.filter(function (p) { return p.x === 0; });
    var observed0 = zeroPts.length
      ? zeroPts.reduce(function (s, p) { return s + p.y; }, 0) / zeroPts.length
      : null;

    var maxY = pts.reduce(function (m, p) { return Math.max(m, p.y); }, 0);
    var opts = mode === "binary"
      ? { alphaMax: 0.1, q0Max: 100 }
      : { alphaMax: 1, q0Max: Math.max(10, maxY * 5) };

    // Zero-price handling: exclude (R-script parity), include as a data
    // point, or fix Q0 at the observed zero-price demand (alpha-only fit).
    var fitPts = posPts;
    var q0FixFailed = false;
    if (zeroMode === "include" && zeroPts.length) fitPts = pts;
    if (zeroMode === "fix" && observed0 != null) {
      if (observed0 > 0) opts.fixedQ0 = observed0;
      else q0FixFailed = true;
    }

    var f = fitPts.length >= 3 ? fit(fitPts, k, opts) : { error: "Too few valid points." };
    var p50 = null, p50InRange = null;
    if (!f.error) {
      var target = mode === "binary" ? 50 : f.Q0 / 2;
      var p = pAtTarget(f.alpha, f.Q0, k, target);
      if (isFinite(p)) {
        // "In range" means within the prices actually presented to
        // respondents -- a tested price 0 extends that range downward.
        var xs = pts.map(function (q) { return q.x; });
        p50 = p;
        p50InRange = p >= Math.min.apply(null, xs) && p <= Math.max.apply(null, xs);
      }
    }
    var pmaxVal = null, omaxVal = null;
    if (!f.error) {
      var pm = pmax(f.alpha, f.Q0, k);
      if (isFinite(pm)) {
        pmaxVal = pm;
        // Omax: the value of demand at Pmax. For percentage data Q is a
        // purchase rate, so this is expected revenue per person offered
        // (Q/100 x P); for quantity data it is the conventional peak
        // expenditure (Q x P).
        var qAtPmax = koff(pm, f.alpha, f.Q0, k);
        omaxVal = pm * (mode === "binary" ? qAtPmax / 100 : qAtPmax);
      }
    }
    // AUC: computed from the raw aggregated points, independent of the fit
    // and always excluding any price-0 point -- reported even when the fit
    // itself fails.
    var aucVal = auc(pts);
    return {
      nFitted: fitPts.length, observed0: observed0, q0FixFailed: q0FixFailed,
      fit: f, p50: p50, p50InRange: p50InRange, pmax: pmaxVal, omax: omaxVal,
      auc: isFinite(aucVal) ? aucVal : null
    };
  }

  return {
    koff: koff, fit: fit, pAtTarget: pAtTarget, pmax: pmax, lambertW0: lambertW0,
    rssOf: rssOf, auc: auc, summarizeSeries: summarizeSeries
  };
});
