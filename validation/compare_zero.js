/* Compares the JS engine's include-zero and fixed-Q0 fits against
   validation/r_results_zero.csv from fit_reference_zero.R.
   Run from the project root: node validation/compare_zero.js */
const fs = require("fs");
const path = require("path");
const { fit } = require("../assets/js/model.js");

const K = 2;
const rRows = fs.readFileSync(path.join(__dirname, "r_results_zero.csv"), "utf8")
  .trim().split("\n").slice(1).map(line => {
    const c = line.split(",").map(s => s.replace(/"/g, ""));
    return {
      file: c[0],
      alpha_inc: +c[1], Q0_inc: +c[2], r2_inc: +c[3], rss_inc: +c[4],
      Q0_fixed: +c[5], alpha_fix: +c[6], r2_fix: +c[7], rss_fix: +c[8]
    };
  });

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
let allOk = true;

function check(label, err, tol) {
  const ok = err <= tol;
  allOk = allOk && ok;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}  (diff ${err.toExponential(2)}, tol ${tol})`);
}

for (const r of rRows) {
  const pts = fs.readFileSync(path.join(__dirname, r.file), "utf8")
    .trim().split("\n").slice(1)
    .map(l => { const [x, y] = l.split(",").map(Number); return { x, y }; });
  const posPts = pts.filter(p => p.x > 0);
  const zeroY = pts.find(p => p.x === 0).y;

  console.log(`\n${r.file} — include mode`);
  const inc = fit(pts, K);
  console.log(`  R : alpha=${r.alpha_inc.toExponential(6)} Q0=${r.Q0_inc.toFixed(6)} R2=${r.r2_inc.toFixed(8)}`);
  console.log(`  JS: alpha=${inc.alpha.toExponential(6)} Q0=${inc.Q0.toFixed(6)} R2=${inc.rSquared.toFixed(8)}`);
  check("alpha", relErr(inc.alpha, r.alpha_inc), 1e-3);
  check("Q0", relErr(inc.Q0, r.Q0_inc), 1e-4);
  check("R2", Math.abs(inc.rSquared - r.r2_inc), 1e-6);
  check("RSS", relErr(inc.rss, r.rss_inc), 1e-6);

  console.log(`${r.file} — fixed-Q0 mode (Q0 = ${r.Q0_fixed})`);
  const fix = fit(posPts, K, { fixedQ0: zeroY });
  console.log(`  R : alpha=${r.alpha_fix.toExponential(6)} R2=${r.r2_fix.toFixed(8)}`);
  console.log(`  JS: alpha=${fix.alpha.toExponential(6)} R2=${fix.rSquared.toFixed(8)} (Q0 held at ${fix.Q0})`);
  check("alpha", relErr(fix.alpha, r.alpha_fix), 1e-3);
  check("Q0 held", relErr(fix.Q0, r.Q0_fixed), 1e-12);
  check("R2", Math.abs(fix.rSquared - r.r2_fix), 1e-6);
  check("RSS", relErr(fix.rss, r.rss_fix), 1e-6);
}
console.log(allOk ? "\nALL MATCH — zero-price modes reproduce the R reference fits." : "\nMISMATCH — investigate before shipping.");
process.exit(allOk ? 0 : 1);
