/* Test datasets that include a price-0 (free) row, for validating the
   include-zero and fixed-Q0 fitting modes. Run: node validation/make_testdata_zero.js */
const fs = require("fs");
const path = require("path");
const { koff } = require("../assets/js/model.js");

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const cases = [
  { name: "agg_testz1", alpha: 2.5e-6, Q0: 95, k: 2, sd: 3,
    prices: [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000], seed: 44 },
  { name: "agg_testz2", alpha: 5e-5, Q0: 80, k: 2, sd: 4,
    prices: [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000], seed: 55 }
];

for (const c of cases) {
  const rng = mulberry32(c.seed);
  const rows = ["x,All"];
  for (const p of c.prices) {
    let y = koff(p, c.alpha, c.Q0, c.k) + gauss(rng) * c.sd;
    y = Math.min(100, Math.max(0, y));
    rows.push(`${p},${y.toFixed(4)}`);
  }
  fs.writeFileSync(path.join(__dirname, c.name + ".csv"), rows.join("\n") + "\n");
  console.log("wrote", c.name + ".csv");
}
