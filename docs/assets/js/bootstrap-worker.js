/* Group-difference bootstrap worker.
   For each of `nBoot` rounds: resample respondents with replacement within
   each of the two groups (keeping each group's size), re-aggregate the
   per-price percentages (or means), refit with the same fitter and settings
   the results page uses, and record the chosen measure for each group.
   Runs off the main thread so the page stays responsive.

   The page passes the model.js cache-busting query as ?m=... so both files
   always load together. */
"use strict";

var modelQuery = new URLSearchParams(self.location.search).get("m") || "";
importScripts("model.js" + (modelQuery ? "?" + modelQuery : ""));

/* mulberry32: small, fast, seedable PRNG so a run can be reproduced. */
function makeRng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* One resampled group -> measure value (NaN if it can't be computed).
   matrix: array of Float64Array rows (one per respondent, one entry per
   price column; NaN = no usable answer). Binary cells are 1/0. */
function resampleMeasure(matrix, prices, job, rng, sums, counts) {
  var n = matrix.length, nP = prices.length, i, p;
  for (p = 0; p < nP; p++) { sums[p] = 0; counts[p] = 0; }
  for (i = 0; i < n; i++) {
    var row = matrix[Math.floor(rng() * n)];
    for (p = 0; p < nP; p++) {
      var v = row[p];
      if (v === v) { sums[p] += v; counts[p]++; }   // v === v is false for NaN
    }
  }
  var pts = [];
  for (p = 0; p < nP; p++) {
    if (counts[p] > 0) {
      pts.push({ x: prices[p], y: job.mode === "binary" ? 100 * sums[p] / counts[p] : sums[p] / counts[p] });
    }
  }
  var sm = DCAModel.summarizeSeries(pts, job.mode, job.k, job.zeroMode);
  var val = job.measure === "auc" ? sm.auc : sm.p50;
  return val == null || !isFinite(val) ? NaN : val;
}

self.onmessage = function (e) {
  var job = e.data;
  try {
    var B = job.nBoot, nP = job.prices.length;
    var rng = makeRng(job.seed);
    var sums = new Float64Array(nP), counts = new Float64Array(nP);
    var drawsA = new Float64Array(B), drawsB = new Float64Array(B);
    var step = Math.max(1, Math.floor(B / 100));
    for (var b = 0; b < B; b++) {
      drawsA[b] = resampleMeasure(job.groupA, job.prices, job, rng, sums, counts);
      drawsB[b] = resampleMeasure(job.groupB, job.prices, job, rng, sums, counts);
      if ((b + 1) % step === 0) self.postMessage({ type: "progress", done: b + 1, total: B });
    }
    self.postMessage({ type: "done", drawsA: drawsA, drawsB: drawsB }, [drawsA.buffer, drawsB.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
