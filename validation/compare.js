/* Fits the same aggregate test CSVs with the site's JS engine and compares
   against validation/r_results.csv from fit_reference.R.
   Run from the project root: node validation/compare.js */
const fs = require("fs");
const path = require("path");
const { fit, pAtTarget } = require("../assets/js/model.js");

const K = 2;
const rRows = fs.readFileSync(path.join(__dirname, "r_results.csv"), "utf8")
  .trim().split("\n").slice(1).map(line => {
    const [file, alpha, Q0, r2, rss, p50] = line.split(",").map(s => s.replace(/"/g, ""));
    return { file, alpha: +alpha, Q0: +Q0, r2: +r2, rss: +rss, p50: p50 === "NA" ? NaN : +p50 };
  });

let allOk = true;
for (const r of rRows) {
  const pts = fs.readFileSync(path.join(__dirname, r.file), "utf8")
    .trim().split("\n").slice(1)
    .map(l => { const [x, y] = l.split(",").map(Number); return { x, y }; });

  const js = fit(pts, K);
  // Match the R script's uniroot behavior: P50 only counts when it falls
  // within the observed price range (the app shows out-of-range values too,
  // but labeled as extrapolated).
  const xs = pts.map(p => p.x).filter(x => x > 0);
  const rawP50 = pAtTarget(js.alpha, js.Q0, K, 50);
  const jsP50 = rawP50 >= Math.min(...xs) && rawP50 <= Math.max(...xs) ? rawP50 : NaN;

  const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  const checks = [
    ["alpha", relErr(js.alpha, r.alpha), 1e-3],
    ["Q0", relErr(js.Q0, r.Q0), 1e-4],
    ["R2", Math.abs(js.rSquared - r.r2), 1e-6],
    ["RSS", relErr(js.rss, r.rss), 1e-6],
    // R's uniroot ran with tol = 0.01, so compare P50 at that granularity
    ["P50", isNaN(r.p50) ? (isNaN(jsP50) ? 0 : Infinity) : Math.abs(jsP50 - r.p50), 0.05]
  ];

  console.log(`\n${r.file}`);
  console.log(`  R : alpha=${r.alpha.toExponential(6)} Q0=${r.Q0.toFixed(6)} R2=${r.r2.toFixed(8)} P50=${r.p50}`);
  console.log(`  JS: alpha=${js.alpha.toExponential(6)} Q0=${js.Q0.toFixed(6)} R2=${js.rSquared.toFixed(8)} P50=${jsP50}`);
  for (const [name, err, tol] of checks) {
    const ok = err <= tol;
    allOk = allOk && ok;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}  (diff ${err.toExponential(2)}, tol ${tol})`);
  }
}
console.log(allOk ? "\nALL MATCH — JS fitter reproduces the R nls fit." : "\nMISMATCH — investigate before shipping.");
process.exit(allOk ? 0 : 1);
