# Demand Curve Analyzer

A client-side web tool for analyzing hypothetical purchase task (HPT) demand data,
by [PROMISE Labs Africa](https://promiselabs.africa/). Target deployment:
`analyzer.promiselabs.africa` (GitHub Pages + CNAME).

## What it does

1. **Upload** minimally cleaned wide survey data (rows = respondents, columns =
   price points; CSV or Excel). Cells can be yes/no purchase responses or
   quantities.
2. **Map columns** — price columns are auto-detected from headers; an optional
   grouping column (sex, site, condition…) enables per-group curves.
3. **Aggregate** — % of respondents purchasing (or mean consumption) at each
   price, overall and per group.
4. **Fit** the exponentiated demand model (Koffarnus, Franck, Stein & Bickel,
   2015), `Q = Q0 · 10^(k(e^(−αQ0P) − 1))`, with k fixed globally (default 2),
   via bounded least squares. Reports Q0, α, R², and P50.
5. **Export** the aggregated table, fitted parameters, and a publication-ready
   chart PNG.

All processing happens in the browser — no data is uploaded anywhere. Sessions
autosave to localStorage so users can resume where they stopped.

## Validation

The JavaScript fitter is validated against the reference R analysis
(`nls`, algorithm "port", start α=1e-7 / Q0=100, bounds α∈[0,0.1], Q0∈[0,100]):

```sh
node validation/make_testdata.js   # generate known-parameter test datasets
Rscript validation/fit_reference.R # fit them with the reference R code
node validation/compare.js         # confirm JS reproduces R (α, Q0, R², RSS, P50)
```

Current status: all parameters agree to ≈9 decimal places; P50 agrees within
R's uniroot tolerance.

## R companion script

[`r/analyzer_companion.R`](r/analyzer_companion.R) reproduces the site's entire
pipeline in R — aggregation, all three zero-price modes, closed-form P50,
individual breakpoints (adapted Stein et al., 2015 criterion), and the figure.
Edit the Configuration block, then `Rscript r/analyzer_companion.R`. Verified to
match the site's output exactly on the sample dataset.

## Local development

```sh
python3 -m http.server 8642
# open http://localhost:8642
```

No build step. Vendored libraries: PapaParse (CSV), SheetJS (Excel),
Plotly (charts).
