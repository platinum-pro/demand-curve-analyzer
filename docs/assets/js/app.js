/* Demand Curve Analyzer — UI, parsing, aggregation, autosave.
   All processing is client-side; session state persists in localStorage. */
(function () {
  "use strict";

  var STORE_KEY = "dca_session_v1";

  /* Categorical palette (validated for CVD separation on white).
     Slot 1 is always "All"; groups take subsequent slots in stable order. */
  var PALETTE = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
  var MAX_GROUPS = PALETTE.length - 1;

  var state = {
    fileName: null,
    headers: [],
    rows: [],
    roles: [],      // per column: "price" | "ignore"
    priceVals: [],  // per column: number | null
    settings: {
      mode: "binary",      // "binary" | "quantity"
      groupIdx: -1,         // column index for grouping, -1 = none
      k: 2,
      currency: "₦",
      showGroups: "all+groups",
      zeroMode: "exclude",  // "exclude" | "include" | "fix"
      hiddenGroups: [],     // group names hidden from charts (display only)
      showP50Lines: true,
      showPmaxLines: true
    },
    clean: {
      filterCol: -1,     // row filter: exclude rows whose value is in filterVals
      filterVals: []
    },
    derivedCols: [],     // user-created recode columns: {name, srcName}
    step: 1,
    rowsOmittedFromSave: false
  };

  function defaultClean() {
    return { filterCol: -1, filterVals: [] };
  }
  var results = null; // computed, not persisted

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- persistence ---------------- */

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
  }

  function saveState() {
    if (!state.fileName) return;
    var payload = {
      v: 2, savedAt: Date.now(),
      fileName: state.fileName, headers: state.headers, rows: state.rows,
      roles: state.roles, priceVals: state.priceVals,
      settings: state.settings, clean: state.clean,
      derivedCols: state.derivedCols, step: state.step
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
      state.rowsOmittedFromSave = false;
      flashSaved();
    } catch (e) {
      // Quota exceeded — keep mapping/settings, drop the raw rows
      try {
        payload.rows = [];
        payload.rowsOmitted = true;
        localStorage.setItem(STORE_KEY, JSON.stringify(payload));
        state.rowsOmittedFromSave = true;
      } catch (e2) { /* storage unavailable — session simply won't persist */ }
    }
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || p.v !== 2 || !p.fileName) return null;
      return p;
    } catch (e) { return null; }
  }

  function clearSaved() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  function flashSaved() {
    var el = $("saved-note");
    if (!el) return;
    var t = new Date();
    el.textContent = "Session saved ✓ " +
      t.toTimeString().slice(0, 5);
    el.classList.add("flash");
    setTimeout(function () { el.classList.remove("flash"); }, 1200);
  }

  /* ---------------- parsing ---------------- */

  function parsePriceHeader(h) {
    var s = String(h == null ? "" : h).replace(/[,\s ]/g, "");
    var matches = s.match(/\d+(?:\.\d+)?/g);
    if (!matches) return null;
    var v = parseFloat(matches[matches.length - 1]);
    return isFinite(v) ? v : null;
  }

  var YES = { "1": 1, "yes": 1, "y": 1, "true": 1, "t": 1 };
  var NO = { "0": 1, "no": 1, "n": 1, "false": 1, "f": 1 };

  function toBool(cell) {
    var s = String(cell == null ? "" : cell).trim();
    if (s === "") return null;
    var key = s.toLowerCase();
    if (YES[key]) return 1;
    if (NO[key]) return 0;
    return null;
  }

  function toNum(cell) {
    var raw = String(cell == null ? "" : cell).trim();
    if (raw === "") return null;
    if (typeof cell === "number") return isFinite(cell) ? cell : null;
    var s = String(cell == null ? "" : cell).replace(/[₦$£€,\s ]/g, "");
    if (s === "") return null;
    var v = parseFloat(s);
    return isFinite(v) ? v : null;
  }

  function ingestTable(name, table) {
    // table: array of arrays; first row = headers
    table = table.filter(function (r) {
      return r && r.some(function (c) { return String(c == null ? "" : c).trim() !== ""; });
    });
    if (table.length < 2) {
      showUploadError("Could not find a header row plus at least one data row in “" + name + "”.");
      return;
    }
    var headers = table[0].map(function (h, i) {
      var s = String(h == null ? "" : h).trim();
      return s === "" ? "Column " + (i + 1) : s;
    });
    var rows = table.slice(1).map(function (r) {
      var out = [];
      for (var i = 0; i < headers.length; i++) out.push(r[i] == null ? "" : r[i]);
      return out;
    });

    state.fileName = name;
    state.headers = headers;
    state.rows = rows;
    state.roles = headers.map(function (h) {
      return parsePriceHeader(h) != null ? "price" : "ignore";
    });
    state.priceVals = headers.map(function (h, i) {
      return state.roles[i] === "price" ? parsePriceHeader(h) : null;
    });
    state.clean = defaultClean();
    state.derivedCols = [];
    autoPickGroup();
    state.step = 2;
    hideUploadError();
    renderAll();
    scheduleSave();
  }

  function autoPickGroup() {
    state.settings.groupIdx = -1;
    for (var i = 0; i < state.headers.length; i++) {
      if (state.roles[i] === "price") continue;
      var uniq = uniqueValues(i);
      if (uniq.length >= 2 && uniq.length <= 10 && state.rows.length >= uniq.length * 3) {
        state.settings.groupIdx = i;
        return;
      }
    }
  }

  function uniqueValues(colIdx) {
    var seen = {}, out = [];
    for (var r = 0; r < state.rows.length; r++) {
      var v = String(state.rows[r][colIdx] == null ? "" : state.rows[r][colIdx]).trim();
      if (v === "" || seen[v]) continue;
      seen[v] = 1; out.push(v);
      if (out.length > 40) break;
    }
    return out;
  }

  function handleFile(file) {
    var name = file.name || "data";
    var ext = name.toLowerCase().split(".").pop();
    if (ext === "xlsx" || ext === "xls") {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var table = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
          ingestTable(name, table);
        } catch (err) {
          showUploadError("Could not read the Excel file: " + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        skipEmptyLines: "greedy",
        complete: function (res) { ingestTable(name, res.data); },
        error: function (err) { showUploadError("Could not parse the file: " + err.message); }
      });
    }
  }

  function loadSample() {
    var res = Papa.parse(window.DCA_SAMPLE_CSV, { skipEmptyLines: "greedy" });
    ingestTable(window.DCA_SAMPLE_NAME, res.data);
  }

  function showUploadError(msg) {
    var el = $("upload-error");
    el.textContent = msg;
    el.style.display = "";
  }
  function hideUploadError() { $("upload-error").style.display = "none"; }

  /* ---------------- aggregation & fitting ---------------- */

  function priceColumns() {
    // Price 0 (a free-price condition) is a valid column; how it enters the
    // fit is governed by settings.zeroMode.
    var cols = [];
    for (var i = 0; i < state.headers.length; i++) {
      if (state.roles[i] === "price" && state.priceVals[i] != null && state.priceVals[i] >= 0) {
        cols.push({ idx: i, x: state.priceVals[i] });
      }
    }
    cols.sort(function (a, b) { return a.x - b.x; });
    return cols;
  }

  function aggregateSeries(rowIdxs, cols, mode, warnings) {
    var points = [], unparsed = 0;
    for (var c = 0; c < cols.length; c++) {
      var yes = 0, no = 0, sum = 0, nNum = 0;
      for (var r = 0; r < rowIdxs.length; r++) {
        var cell = state.rows[rowIdxs[r]][cols[c].idx];
        if (mode === "binary") {
          var b = toBool(cell);
          if (b === 1) yes++;
          else if (b === 0) no++;
          else if (String(cell == null ? "" : cell).trim() !== "") unparsed++;
        } else {
          var v = toNum(cell);
          if (v != null) { sum += v; nNum++; }
          else if (String(cell == null ? "" : cell).trim() !== "") unparsed++;
        }
      }
      if (mode === "binary") {
        var nValid = yes + no;
        if (nValid > 0) points.push({ x: cols[c].x, y: 100 * yes / nValid, n: nValid });
      } else {
        if (nNum > 0) points.push({ x: cols[c].x, y: sum / nNum, n: nNum });
      }
    }
    if (unparsed > 0) warnings.push(unparsed + " cell(s) could not be interpreted and were skipped.");
    return points;
  }

  function compute() {
    var cols = priceColumns();
    var mode = state.settings.mode;
    var k = state.settings.k;
    var zeroMode = state.settings.zeroMode || "exclude";
    var warnings = [];
    var posCount = cols.filter(function (c) { return c.x > 0; }).length;
    if (posCount < 3) {
      return { error: "At least 3 positive price columns are needed (found " + posCount + "). Check the column mapping." };
    }
    var hasZeroCol = cols.some(function (c) { return c.x === 0; });
    if (zeroMode !== "exclude" && !hasZeroCol) {
      warnings.push("No price-0 column in the data — the zero-price setting has no effect and Q₀ is fitted as usual.");
    }

    var allIdxs = includedRowIdxs();
    var excluded = state.rows.length - allIdxs.length;
    if (excluded > 0) warnings.push(excluded + " respondent(s) excluded by the row filter (Clean & recode step).");
    var seriesDefs = [{ name: "All", rowIdxs: allIdxs, color: PALETTE[0] }];

    if (state.settings.groupIdx >= 0) {
      var gi = state.settings.groupIdx;
      var groupsMap = {}, order = [];
      allIdxs.forEach(function (r) {
        var g = String(state.rows[r][gi] == null ? "" : state.rows[r][gi]).trim();
        if (g === "") g = "(blank)";
        if (!groupsMap[g]) { groupsMap[g] = []; order.push(g); }
        groupsMap[g].push(r);
      });
      order.sort(); // stable, deterministic color assignment
      if (order.length > MAX_GROUPS) {
        warnings.push("Only the " + MAX_GROUPS + " largest groups are shown (" + order.length + " found).");
        order.sort(function (a, b) { return groupsMap[b].length - groupsMap[a].length; });
        order = order.slice(0, MAX_GROUPS).sort();
      }
      order.forEach(function (g, gIdx) {
        seriesDefs.push({ name: g, rowIdxs: groupsMap[g], color: PALETTE[gIdx + 1] });
      });
    }

    var series = seriesDefs.map(function (def) {
      var pts = aggregateSeries(def.rowIdxs, cols, mode, warnings);
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
      if (zeroMode === "include" && zeroPts.length) fitPts = pts;
      if (zeroMode === "fix" && observed0 != null) {
        if (observed0 > 0) opts.fixedQ0 = observed0;
        else warnings.push("“" + def.name + "”: observed price-0 demand is 0, so Q₀ cannot be fixed to it; fitted normally.");
      }

      var fit = fitPts.length >= 3 ? DCAModel.fit(fitPts, k, opts) : { error: "Too few valid points." };
      var p50 = null, p50InRange = null;
      if (!fit.error) {
        var target = mode === "binary" ? 50 : fit.Q0 / 2;
        var p = DCAModel.pAtTarget(fit.alpha, fit.Q0, k, target);
        if (isFinite(p)) {
          // "In range" means within the prices actually presented to
          // respondents — a tested price 0 extends that range downward.
          var xs = pts.map(function (q) { return q.x; });
          p50 = p;
          p50InRange = p >= Math.min.apply(null, xs) && p <= Math.max.apply(null, xs);
        }
      }
      var pmaxVal = null, omaxVal = null;
      if (!fit.error) {
        var pm = DCAModel.pmax(fit.alpha, fit.Q0, k);
        if (isFinite(pm)) {
          pmaxVal = pm;
          // Omax: the value of demand at Pmax. For percentage data Q is a
          // purchase rate, so this is expected revenue per person offered
          // (Q/100 x P); for quantity data it is the conventional peak
          // expenditure (Q x P).
          var qAtPmax = DCAModel.koff(pm, fit.alpha, fit.Q0, k);
          omaxVal = pm * (mode === "binary" ? qAtPmax / 100 : qAtPmax);
        }
      }
      // AUC: computed from the raw aggregated points (log-price adaptation
      // of Myerson et al., 2001 — see model.js), independent of the fit and
      // always excluding any price-0 point — reported even when the fit
      // itself fails.
      var aucVal = DCAModel.auc(pts);
      return {
        name: def.name, color: def.color, n: def.rowIdxs.length,
        rowIdxs: def.rowIdxs,
        points: pts, nFitted: fitPts.length, observed0: observed0,
        fit: fit, p50: p50, p50InRange: p50InRange, pmax: pmaxVal, omax: omaxVal,
        auc: isFinite(aucVal) ? aucVal : null
      };
    });

    var breakpoints = mode === "binary" ? computeBreakpoints(cols, allIdxs) : null;

    return { series: series, cols: cols, mode: mode, warnings: warnings, hasZeroCol: hasZeroCol, breakpoints: breakpoints };
  }

  function includedRowIdxs() {
    var f = state.clean;
    var out = [];
    for (var r = 0; r < state.rows.length; r++) {
      if (f.filterCol >= 0 && f.filterVals.length) {
        var v = String(state.rows[r][f.filterCol] == null ? "" : state.rows[r][f.filterCol]).trim();
        if (f.filterVals.indexOf(v) >= 0) continue;
      }
      out.push(r);
    }
    return out;
  }

  /* Individual breakpoints for binary data (adapted from Stein et al., 2015):
     a pattern is systematic when it has <= 2 reversals (adjacent No->Yes
     transitions across the ascending price sequence). For systematic
     responders with at least one adjacent Yes->No transition, the breakpoint
     is the geometric mean of the last "Yes" price and the first "No" price. */
  function computeBreakpoints(cols, rowIdxs) {
    var out = [];
    rowIdxs.forEach(function (r) {
      var seq = [];
      for (var c = 0; c < cols.length; c++) {
        var b = toBool(state.rows[r][cols[c].idx]);
        if (b !== null) seq.push({ x: cols[c].x, b: b });
      }
      var reversals = 0;
      for (var i = 0; i + 1 < seq.length; i++) {
        if (seq[i].b === 0 && seq[i + 1].b === 1) reversals++;
      }
      // The breakpoint marks the TERMINAL transition to rejection: the last
      // "Yes" anywhere in the sequence, and the first "No" that follows it.
      // Stray earlier "No"s (tolerated by the reversal criterion) do not
      // define the breakpoint.
      var lastYesIdx = -1;
      for (var j = 0; j < seq.length; j++) if (seq[j].b === 1) lastYesIdx = j;
      var lastYes = lastYesIdx >= 0 ? seq[lastYesIdx].x : null;
      var firstNoAfter = null;
      for (var m = lastYesIdx + 1; m < seq.length; m++) {
        if (seq[m].b === 0) { firstNoAfter = seq[m].x; break; }
      }
      var systematic = seq.length > 0 && reversals <= 2;
      var allYes = seq.length > 0 && seq.every(function (p) { return p.b === 1; });
      var allNo = seq.length > 0 && seq.every(function (p) { return p.b === 0; });

      var category, bp = null;
      if (seq.length === 0) category = "no data";
      else if (!systematic) category = "nonsystematic (excluded)";
      else if (allYes) category = "purchased at all prices";
      else if (allNo) category = "never purchased";
      else if (firstNoAfter === null) category = "still purchasing at highest price";
      else if (lastYes > 0) {
        category = "breakpoint";
        bp = Math.sqrt(lastYes * firstNoAfter);
      } else {
        category = "no computable breakpoint (price 0 involved)";
      }
      out.push({
        row: r, answered: seq.length, reversals: reversals,
        systematic: systematic, category: category,
        lastYes: lastYes, firstNo: firstNoAfter, bp: bp
      });
    });
    return out;
  }

  /* ---------------- formatting ---------------- */

  function fmtPrice(v) {
    if (v == null || !isFinite(v)) return "—";
    var digits = v < 10 ? 2 : v < 1000 ? 1 : 0;
    return state.settings.currency + v.toLocaleString("en-US", {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    });
  }
  function fmtNum(v, d) {
    return v == null || !isFinite(v) ? "—" :
      v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  /* Displays alpha in manuscript notation (2.958 × 10⁻⁶); CSV exports keep
     plain exponential notation for machine readability. */
  function fmtAlpha(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v === 0) return "0";
    var parts = v.toExponential(3).split("e");
    var exp = parseInt(parts[1], 10);
    return parts[0] + " × 10<sup>" + String(exp).replace("-", "−") + "</sup>";
  }
  function hexToRgba(hex, alpha) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + alpha + ")";
  }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function meanOf(arr) {
    return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : null;
  }
  function sdOf(arr) {
    if (arr.length < 2) return null;
    var m = meanOf(arr);
    return Math.sqrt(arr.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (arr.length - 1));
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------------- rendering ---------------- */

  function renderAll() {
    renderStepper();
    ["1", "2", "3", "4"].forEach(function (n) {
      $("step-" + n).classList.toggle("visible", state.step === +n);
    });
    if (state.step === 2) renderClean();
    if (state.step === 3) renderMapping();
    if (state.step === 4) renderResults();
  }

  function renderStepper() {
    var pills = document.querySelectorAll(".step-pill");
    pills.forEach(function (p) {
      var n = +p.dataset.step;
      p.classList.toggle("active", n === state.step);
      p.classList.toggle("done", n < state.step);
      var reachable = n === 1 || state.fileName;
      p.classList.toggle("clickable", !!reachable && n !== state.step);
    });
  }

  function renderMapping() {
    var nPrice = state.roles.filter(function (r) { return r === "price"; }).length;
    var included = includedRowIdxs().length;
    var excludedNote = included < state.rows.length
      ? " — " + (state.rows.length - included) + " excluded in Clean & recode, " + included + " in analysis"
      : "";
    $("map-summary").textContent =
      "“" + state.fileName + "” — " + state.rows.length + " respondents" + excludedNote + ", " +
      state.headers.length + " columns (" + nPrice + " detected as price points).";

    // mode radios
    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.checked = r.value === state.settings.mode;
    });

    // group select
    var gs = $("group-select");
    gs.innerHTML = "";
    var optNone = document.createElement("option");
    optNone.value = "-1"; optNone.textContent = "None — fit “All” only";
    gs.appendChild(optNone);
    state.headers.forEach(function (h, i) {
      if (state.roles[i] === "price") return;
      var uniq = uniqueValues(i);
      if (uniq.length < 2 || uniq.length > 30) return;
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = h + " (" + uniq.length + " groups: " + uniq.slice(0, 4).join(", ") + (uniq.length > 4 ? ", …" : "") + ")";
      gs.appendChild(o);
    });
    gs.value = String(state.settings.groupIdx);
    if (gs.value !== String(state.settings.groupIdx)) { // option not present
      state.settings.groupIdx = -1; gs.value = "-1";
    }

    // mapping table
    var html = "<table><thead><tr><th>Column</th><th>Role</th><th>Price value</th><th>Example values</th></tr></thead><tbody>";
    state.headers.forEach(function (h, i) {
      var uniq = uniqueValues(i);
      html += "<tr>" +
        "<td><strong>" + esc(h) + "</strong></td>" +
        "<td><select class='role-sel' data-col='" + i + "'>" +
        "<option value='price'" + (state.roles[i] === "price" ? " selected" : "") + ">Price point</option>" +
        "<option value='ignore'" + (state.roles[i] !== "price" ? " selected" : "") + ">Not a price (ID / group / other)</option>" +
        "</select></td>" +
        "<td>" + (state.roles[i] === "price"
          ? "<input class='price-val' type='number' step='any' data-col='" + i + "' value='" + (state.priceVals[i] != null ? state.priceVals[i] : "") + "'>"
          : "—") + "</td>" +
        "<td>" + esc(uniq.slice(0, 3).join(", ")) + (uniq.length > 3 ? ", …" : "") + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    $("mapping-table").innerHTML = html;

    $("mapping-table").querySelectorAll(".role-sel").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var i = +sel.dataset.col;
        state.roles[i] = sel.value;
        if (sel.value === "price" && state.priceVals[i] == null) {
          state.priceVals[i] = parsePriceHeader(state.headers[i]);
        }
        renderMapping(); scheduleSave();
      });
    });
    $("mapping-table").querySelectorAll(".price-val").forEach(function (inp) {
      inp.addEventListener("change", function () {
        state.priceVals[+inp.dataset.col] = inp.value === "" ? null : +inp.value;
        renderMapWarnings(); scheduleSave();
      });
    });

    // preview
    var maxCols = Math.min(state.headers.length, 14);
    var ph = "<table><thead><tr>";
    for (var c = 0; c < maxCols; c++) ph += "<th>" + esc(state.headers[c]) + "</th>";
    if (maxCols < state.headers.length) ph += "<th>… +" + (state.headers.length - maxCols) + " more</th>";
    ph += "</tr></thead><tbody>";
    state.rows.slice(0, 8).forEach(function (row) {
      ph += "<tr>";
      for (var c2 = 0; c2 < maxCols; c2++) ph += "<td>" + esc(row[c2]) + "</td>";
      if (maxCols < state.headers.length) ph += "<td>…</td>";
      ph += "</tr>";
    });
    ph += "</tbody></table>";
    $("preview-table").innerHTML = ph;

    renderMapWarnings();
  }

  function renderMapWarnings() {
    var cols = priceColumns();
    var posCount = cols.filter(function (c) { return c.x > 0; }).length;
    var msgs = [];
    if (posCount < 3) msgs.push("⚠ At least 3 positive price columns are needed to fit a curve (currently " + posCount + ").");
    var seen = {};
    cols.forEach(function (c) {
      if (seen[c.x]) msgs.push("⚠ Two columns share the price value " + c.x + " — both will be used as separate data points.");
      seen[c.x] = 1;
    });
    for (var i = 0; i < state.headers.length; i++) {
      if (state.roles[i] === "price" && (state.priceVals[i] == null || state.priceVals[i] < 0)) {
        msgs.push("⚠ “" + state.headers[i] + "” is marked as a price but has no valid price value; it will be skipped.");
      }
    }
    if (cols.some(function (c) { return c.x === 0; })) {
      msgs.push("ℹ A price-0 (free) column was detected. By default it is shown but excluded from curve fitting — you can change this in the Results settings.");
    }
    $("map-warnings").innerHTML = msgs.map(esc).join("<br>");
    $("to-results").disabled = posCount < 3;
  }

  function visibleSeries() {
    if (!results || results.error) return [];
    var mode = state.settings.showGroups;
    var hidden = state.settings.hiddenGroups || [];
    var vis = results.series.filter(function (s, i) {
      if (results.series.length === 1) return true;
      if (i > 0 && hidden.indexOf(s.name) >= 0) return false;
      if (mode === "all") return i === 0;
      if (mode === "groups") return i > 0;
      return true;
    });
    return vis.length ? vis : [results.series[0]];
  }

  function renderResults() {
    $("currency-input").value = state.settings.currency;
    $("k-input").value = state.settings.k;
    $("show-groups").value = state.settings.showGroups;
    $("zero-mode").value = state.settings.zeroMode || "exclude";
    $("show-p50-lines").checked = state.settings.showP50Lines !== false;
    $("show-pmax-lines").checked = !!state.settings.showPmaxLines;
    $("show-groups").disabled = !results || results.error || results.series.length === 1;

    results = compute();

    if (results.error) {
      $("agg-warnings").textContent = "⚠ " + results.error;
      $("result-cards").innerHTML = "";
      $("params-hint").textContent = "";
      $("agg-table").innerHTML = "";
      $("individual-section").style.display = "none";
      $("revenue-details").style.display = "none";
      Plotly.purge($("chart"));
      return;
    }
    $("individual-section").style.display = "";
    $("show-groups").disabled = results.series.length === 1;
    $("agg-warnings").innerHTML = results.warnings.map(function (w) { return esc("⚠ " + w); }).join("<br>");

    renderGroupToggles();
    renderCards();
    renderChart();
    renderRevenueCurve();
    renderIndividuals();
    renderBreakpoints();
    renderAggTable();
  }

  function renderGroupToggles() {
    var field = $("group-toggle-field");
    var box = $("group-toggles");
    if (!results || results.error || results.series.length <= 1) {
      field.style.display = "none";
      box.innerHTML = "";
      return;
    }
    field.style.display = "";
    var hidden = state.settings.hiddenGroups || [];
    box.innerHTML = results.series.slice(1).map(function (s) {
      var checked = hidden.indexOf(s.name) < 0 ? " checked" : "";
      return "<label><input type='checkbox' class='group-toggle' value=\"" + esc(s.name) + "\"" + checked + ">" +
        "<span class='swatch' style='background:" + s.color + "'></span> " + esc(s.name) + "</label>";
    }).join("");
    box.querySelectorAll(".group-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var name = cb.value;
        var h = state.settings.hiddenGroups || (state.settings.hiddenGroups = []);
        if (cb.checked) state.settings.hiddenGroups = h.filter(function (x) { return x !== name; });
        else if (h.indexOf(name) < 0) h.push(name);
        renderResults(); scheduleSave();
      });
    });
  }

  function renderBreakpoints() {
    var section = $("breakpoint-section");
    if (!results || results.error || results.mode !== "binary" || !results.breakpoints) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    var bps = {};
    results.breakpoints.forEach(function (b) { bps[b.row] = b; });
    var html = "<table><thead><tr><th>Series</th><th class='num'>n</th>" +
      "<th class='num'>With breakpoint</th><th class='num'>Median</th><th class='num'>Mean</th>" +
      "<th class='num'>SD</th><th class='num'>Range</th>" +
      "<th class='num'>All Yes</th><th class='num'>All No</th>" +
      "<th class='num'>Nonsystematic (excluded)</th><th class='num'>Other</th></tr></thead><tbody>";
    results.series.forEach(function (s) {
      var sub = s.rowIdxs.map(function (r) { return bps[r]; }).filter(Boolean);
      var vals = sub.filter(function (b) { return b.bp != null; }).map(function (b) { return b.bp; });
      var count = function (cat) {
        return sub.filter(function (b) { return b.category === cat; }).length;
      };
      var other = sub.length - vals.length - count("purchased at all prices") -
        count("never purchased") - count("nonsystematic (excluded)");
      html += "<tr><td><span class='swatch' style='background:" + s.color + "'></span> " + esc(s.name) + "</td>" +
        "<td class='num'>" + sub.length + "</td>" +
        "<td class='num'>" + vals.length + "</td>" +
        "<td class='num'>" + fmtPrice(median(vals)) + "</td>" +
        "<td class='num'>" + fmtPrice(meanOf(vals)) + "</td>" +
        "<td class='num'>" + (sdOf(vals) != null ? fmtPrice(sdOf(vals)) : "—") + "</td>" +
        "<td class='num'>" + (vals.length ? fmtPrice(Math.min.apply(null, vals)) + " – " + fmtPrice(Math.max.apply(null, vals)) : "—") + "</td>" +
        "<td class='num'>" + count("purchased at all prices") + "</td>" +
        "<td class='num'>" + count("never purchased") + "</td>" +
        "<td class='num'>" + count("nonsystematic (excluded)") + "</td>" +
        "<td class='num'>" + other + "</td></tr>";
    });
    html += "</tbody></table>";
    $("breakpoint-table").innerHTML = html;
  }

  function p50Label(s) {
    if (s.fit.error) return "—";
    if (s.p50 == null) return "not reached";
    var txt = fmtPrice(s.p50);
    if (!s.p50InRange) txt += " (extrapolated)";
    return txt;
  }

  function renderCards() {
    var mode = results.mode;
    var html = "";
    visibleSeries().forEach(function (s) {
      var f = s.fit;
      var p50Name = mode === "binary" ? "P<sub>50</sub>" : "Price at ½Q₀";
      html += "<div class='card'>" +
        "<div class='label'><span class='swatch' style='background:" + s.color + "'></span>" +
        esc(s.name) + " · n=" + s.n + "</div>";
      var aucStat = "<div class='stat'>AUC = " + fmtNum(s.auc, 3) + "</div>";
      if (f.error) {
        html += "<div class='value'>fit failed</div><div class='sub'>" + esc(f.error) + "</div>" +
          "<div class='stats'>" + aucStat + "</div>";
      } else {
        html += "<div class='value'>" + p50Name + " = " + p50Label(s) + "</div>" +
          "<div class='stats'>" +
          "<div class='stat'>Q₀ = " + fmtNum(f.Q0, 1) + (f.q0Fixed ? " (fixed)" : "") + "</div>" +
          aucStat +
          "<div class='stat'>α = " + fmtAlpha(f.alpha) + "</div>" +
          "<div class='stat'>P<sub>max</sub> = " + fmtPrice(s.pmax) + "</div>" +
          "<div class='stat'>O<sub>max</sub> = " + fmtPrice(s.omax) +
            (mode === "binary" && s.omax != null ? " per person" : "") + "</div>" +
          "<div class='stat'>R² = " + fmtNum(f.rSquared, 3) + "</div>" +
          "<div class='stat'>Prices fitted = " + s.nFitted + "</div>" +
          "</div>";
      }
      html += "</div>";
    });
    $("result-cards").innerHTML = html;
    var hint = mode === "binary"
      ? "Oₘₐₓ and Pₘₐₓ are the expected revenue per person offered, and the price it peaks at, if the product were priced to maximize revenue — meaningful when price in your study represents a real payment or fee."
      : "Oₘₐₓ and Pₘₐₓ are the peak spending per person, and the price it peaks at — meaningful when price in your study represents a real payment or fee.";
    hint += " AUC is computed directly from the aggregated data, not the fitted curve, so it's unaffected by fit quality — closer to 1 means demand stayed high across the whole price range tested, closer to 0 means it fell off quickly.";
    $("params-hint").textContent = hint;
  }

  function renderChart() {
    var mode = results.mode;
    var vis = visibleSeries();
    var showLegend = vis.length > 1;
    var traces = [];
    var maxY = 0;

    // A log axis cannot show price 0; when a zero-price condition exists it
    // is plotted at a pseudo-position one decade below the lowest positive
    // price (standard convention in demand figures), and fitted curves are
    // extended to that left edge, where Q is visually indistinguishable
    // from Q0.
    var allPosX = [];
    var hasZero = false;
    vis.forEach(function (s) {
      s.points.forEach(function (p) {
        if (p.x > 0) allPosX.push(p.x);
        else hasZero = true;
      });
    });
    var minPos = allPosX.length ? Math.min.apply(null, allPosX) : 1;
    var pseudoX = minPos / 10;

    vis.forEach(function (s) {
      s.points.forEach(function (p) { maxY = Math.max(maxY, p.y); });
      traces.push({
        x: s.points.map(function (p) { return p.x === 0 ? pseudoX : p.x; }),
        y: s.points.map(function (p) { return p.y; }),
        customdata: s.points.map(function (p) { return p.x.toLocaleString("en-US"); }),
        mode: "markers",
        type: "scatter",
        name: s.name,
        legendgroup: s.name,
        showlegend: showLegend,
        marker: { color: s.color, size: 9, line: { color: "#ffffff", width: 2 } },
        hovertemplate: esc(s.name) + "<br>Price %{customdata}<br>" +
          (mode === "binary" ? "%{y:.1f}% purchasing" : "Mean %{y:.2f}") + "<extra></extra>"
      });
      if (!s.fit.error) {
        var xs = s.points.map(function (p) { return p.x; }).filter(function (x) { return x > 0; });
        var lo = Math.log10(hasZero ? pseudoX : Math.min.apply(null, xs));
        var hi = Math.log10(Math.max.apply(null, xs));
        var fx = [], fy = [];
        for (var i = 0; i <= 160; i++) {
          var x = Math.pow(10, lo + (hi - lo) * i / 160);
          fx.push(x);
          var y = DCAModel.koff(x, s.fit.alpha, s.fit.Q0, s.fit.k);
          fy.push(y);
          maxY = Math.max(maxY, y);
        }
        traces.push({
          x: fx, y: fy, mode: "lines", type: "scatter",
          name: s.name + " (fit)", legendgroup: s.name, showlegend: false,
          line: { color: s.color, width: 2 },
          hoverinfo: "skip"
        });
      }
    });

    var shapes = [];
    if (mode === "binary" && state.settings.showP50Lines !== false) {
      shapes.push({
        type: "line", xref: "paper", x0: 0, x1: 1, y0: 50, y1: 50,
        line: { color: "#9a9a9a", width: 1, dash: "dot" }
      });
    }
    vis.forEach(function (s) {
      if (state.settings.showP50Lines !== false && s.p50 != null && s.p50InRange) {
        shapes.push({
          type: "line", x0: s.p50, x1: s.p50, yref: "paper", y0: 0, y1: 1,
          line: { color: s.color, width: 1, dash: "dash" }
        });
      }
      // Pmax lines use a dash-dot style (vs. P50's plain dash) so the two
      // stay visually distinct when both are shown in the same series color.
      if (state.settings.showPmaxLines && s.pmax != null) {
        shapes.push({
          type: "line", x0: s.pmax, x1: s.pmax, yref: "paper", y0: 0, y1: 1,
          line: { color: s.color, width: 1, dash: "dashdot" }
        });
      }
    });

    // decade ticks within observed range; the pseudo-position gets a "0" tick
    var tickVals = [], tickText = [];
    if (allPosX.length) {
      var loD = Math.floor(Math.log10(minPos));
      var hiD = Math.ceil(Math.log10(Math.max.apply(null, allPosX)));
      if (hasZero) { tickVals.push(pseudoX); tickText.push("0"); }
      for (var d = loD; d <= hiD; d++) {
        tickVals.push(Math.pow(10, d));
        tickText.push(Math.pow(10, d).toLocaleString("en-US"));
      }
    }

    var annotations = [];
    if (hasZero) {
      annotations.push({
        xref: "paper", yref: "paper", x: 0, y: -0.16,
        xanchor: "left", yanchor: "top", showarrow: false,
        text: "Price 0 is shown at an arbitrary position on the log-scaled axis.",
        font: { size: 11, color: "#666" }
      });
    }

    var layout = {
      margin: { t: 16, r: 24, b: hasZero ? 74 : 56, l: 90 },
      font: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", color: "#1a1a1a", size: 13 },
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      xaxis: {
        type: "log", title: { text: "Price (" + state.settings.currency + ")" },
        tickvals: tickVals,
        ticktext: tickText,
        showgrid: false, zeroline: false,
        linecolor: "#1a1a1a", ticks: "outside", tickcolor: "#1a1a1a",
        tickfont: { color: "#666" }
      },
      yaxis: {
        title: {
          text: mode === "binary" ? "Respondents purchasing (%)" : "Mean consumption",
          standoff: 12
        },
        range: [0, maxY * 1.08],
        gridcolor: "#ececec", zeroline: false,
        linecolor: "#1a1a1a", ticks: "outside", tickcolor: "#1a1a1a",
        tickfont: { color: "#666" }
      },
      shapes: shapes,
      annotations: annotations,
      hovermode: "closest",
      legend: { orientation: "h", y: 1.08, x: 0 }
    };

    Plotly.react($("chart"), traces, layout, { responsive: true, displayModeBar: false });
  }

  /* Revenue curve: price x predicted demand, per series. The demand model
     never lets Q reach true zero (it floors near 1% of Q0), so revenue
     eventually rises again at extreme prices -- an artifact of the floor,
     not a real second pricing opportunity. To avoid showing that, each
     curve stops once predicted demand falls below 3% of Q0, and never
     extends past the highest price actually tested. */
  function renderRevenueCurve() {
    var container = $("revenue-details");
    var mode = results.mode;
    var vis = visibleSeries().filter(function (s) { return s.pmax != null && s.omax != null; });
    if (!vis.length) { container.style.display = "none"; return; }

    $("revenue-hint").textContent = (mode === "binary"
      ? "Expected revenue per person if the product were priced at each point on the x-axis."
      : "Spending per person at each price.") +
      " The curve stops once predicted demand falls below 3% of Q₀ — beyond that point too few respondents are driving the estimate to trust it.";

    var showLegend = vis.length > 1;
    var traces = [], shapes = [], maxY = 0, drawn = false;

    vis.forEach(function (s) {
      var f = s.fit;
      var xs = s.points.map(function (p) { return p.x; }).filter(function (x) { return x > 0; });
      if (!xs.length) return;
      var minP = Math.min.apply(null, xs), maxObsP = Math.max.apply(null, xs);
      var cutoff = DCAModel.pAtTarget(f.alpha, f.Q0, f.k, 0.03 * f.Q0);
      var endP = isFinite(cutoff) ? Math.min(cutoff, maxObsP) : maxObsP;
      if (endP <= minP) return;

      var fx = [], fy = [];
      var lo = Math.log10(minP), hi = Math.log10(endP);
      for (var i = 0; i <= 160; i++) {
        var x = Math.pow(10, lo + (hi - lo) * i / 160);
        var q = DCAModel.koff(x, f.alpha, f.Q0, f.k);
        var y = x * (mode === "binary" ? q / 100 : q);
        fx.push(x); fy.push(y);
        maxY = Math.max(maxY, y);
      }
      traces.push({
        x: fx, y: fy, mode: "lines", type: "scatter",
        name: s.name, legendgroup: s.name, showlegend: showLegend,
        line: { color: s.color, width: 2 },
        hovertemplate: esc(s.name) + "<br>Price %{x:,.0f}<br>" + (mode === "binary" ? "Revenue" : "Spending") + " %{y:,.1f}<extra></extra>"
      });
      drawn = true;

      if (s.pmax <= endP) {
        if (state.settings.showPmaxLines) {
          traces.push({
            x: [s.pmax], y: [s.omax], mode: "markers", type: "scatter",
            name: s.name + " (Pmax)", legendgroup: s.name, showlegend: false,
            marker: { color: s.color, size: 9, line: { color: "#ffffff", width: 2 } },
            hovertemplate: "P<sub>max</sub> " + esc(s.name) + "<br>%{x:,.0f}<br>O<sub>max</sub> %{y:,.1f}<extra></extra>"
          });
          shapes.push({
            type: "line", x0: s.pmax, x1: s.pmax, yref: "paper", y0: 0, y1: 1,
            line: { color: s.color, width: 1, dash: "dash" }
          });
        }
        maxY = Math.max(maxY, s.omax);
      }
    });

    if (!drawn) { container.style.display = "none"; return; }
    container.style.display = "";

    var allX = [];
    vis.forEach(function (s) { s.points.forEach(function (p) { if (p.x > 0) allX.push(p.x); }); });
    var tickVals = [], tickText = [];
    if (allX.length) {
      var loD = Math.floor(Math.log10(Math.min.apply(null, allX)));
      var hiD = Math.ceil(Math.log10(Math.max.apply(null, allX)));
      for (var d = loD; d <= hiD; d++) {
        tickVals.push(Math.pow(10, d));
        tickText.push(Math.pow(10, d).toLocaleString("en-US"));
      }
    }

    var layout = {
      margin: { t: 16, r: 24, b: 56, l: 90 },
      font: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", color: "#1a1a1a", size: 13 },
      paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
      xaxis: {
        type: "log", title: { text: "Price (" + state.settings.currency + ")" },
        tickvals: tickVals, ticktext: tickText,
        showgrid: false, zeroline: false,
        linecolor: "#1a1a1a", ticks: "outside", tickcolor: "#1a1a1a", tickfont: { color: "#666" }
      },
      yaxis: {
        title: { text: (mode === "binary" ? "Expected revenue (" : "Spending (") + state.settings.currency + "/person)" },
        range: [0, maxY * 1.15],
        gridcolor: "#ececec", zeroline: false,
        linecolor: "#1a1a1a", ticks: "outside", tickcolor: "#1a1a1a", tickfont: { color: "#666" }
      },
      shapes: shapes,
      hovermode: "closest",
      legend: { orientation: "h", y: 1.08, x: 0 }
    };
    // A closed <details> gives its content zero size, so Plotly would lay
    // out into a broken (often zero-size) box if drawn while hidden -- skip
    // the draw until the panel is actually open; the "toggle" listener
    // below re-runs this function at that point, once the container has a
    // real size to measure.
    if (container.open) {
      Plotly.react($("revenue-chart"), traces, layout, { responsive: true, displayModeBar: false });
    }
  }

  /* ------------- individual responses (raster + distribution) ------------- */

  function renderIndividuals() {
    var mode = results.mode;
    $("indiv-hint").textContent = mode === "binary"
      ? "Every respondent's raw responses — one row per person, one column per price, sorted by breakpoint. Filled cells are “Yes”; nonsystematic responders appear at the bottom of each block."
      : "Every respondent's raw responses — one row per person, one column per price, shaded by reported quantity (darker = more), sorted by average quantity.";
    drawRaster();
    var showDist = mode === "binary";
    $("bp-dist").style.display = showDist ? "" : "none";
    $("dl-dist").style.display = showDist ? "" : "none";
    if (showDist) renderBpDist();
  }

  function rasterBlocks() {
    // One block per group when grouping is active and the "Curves shown"
    // setting isn't restricted to "All respondents only" -- otherwise a
    // single block for the full sample. Splitting by group here would
    // duplicate every respondent (once under "All", again under their
    // group), so unlike the aggregate chart, "all+groups" mode shows
    // per-group blocks only, not an "All" block plus group blocks.
    // Groups hidden via the "Groups shown" toggle are omitted.
    var hidden = state.settings.hiddenGroups || [];
    if (results.series.length === 1 || state.settings.showGroups === "all") {
      return [results.series[0]];
    }
    var blocks = results.series.slice(1).filter(function (s) { return hidden.indexOf(s.name) < 0; });
    return blocks.length ? blocks : [results.series[0]];
  }

  function drawRaster() {
    var mode = results.mode;
    var cols = results.cols;
    var canvas = $("raster");
    var ctx = canvas.getContext("2d");
    var wrapW = $("raster-wrap").clientWidth || 900;
    var dpr = window.devicePixelRatio || 1;

    var bpByRow = {};
    (results.breakpoints || []).forEach(function (b) { bpByRow[b.row] = b; });

    function sortKey(r) {
      if (mode === "binary") {
        var b = bpByRow[r];
        if (!b) return -2;
        if (b.category === "nonsystematic (excluded)") return -1;
        if (b.category === "purchased at all prices") return 1e15;
        if (b.category === "still purchasing at highest price") return 1e14;
        if (b.bp != null) return b.bp;
        if (b.category === "never purchased") return 0;
        return 0.1;
      }
      var sum = 0, n = 0;
      cols.forEach(function (c) {
        var v = toNum(state.rows[r][c.idx]);
        if (v != null) { sum += v; n++; }
      });
      return n ? sum / n : -1;
    }

    var blocks = rasterBlocks().map(function (s) {
      return {
        name: s.name, color: s.color,
        rows: s.rowIdxs.slice().sort(function (a, b) { return sortKey(b) - sortKey(a); })
      };
    });

    var totalRows = blocks.reduce(function (a, b) { return a + b.rows.length; }, 0);
    if (!totalRows || !cols.length) { canvas.width = 0; canvas.height = 0; return; }

    var rowH = Math.max(2, Math.min(6, Math.floor(560 / totalRows)));
    var labelH = 18, blockGap = 12, axisH = 40, bandW = 6, yLabelW = 18;
    var padL = yLabelW + bandW + 2;
    var height = blocks.reduce(function (a, b) { return a + labelH + b.rows.length * rowH + blockGap; }, 0) + axisH;
    var cellW = (wrapW - padL) / cols.length;

    canvas.style.width = wrapW + "px";
    canvas.style.height = height + "px";
    canvas.width = Math.round(wrapW * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, wrapW, height);

    var maxV = 1;
    if (mode === "quantity") {
      blocks.forEach(function (b) {
        b.rows.forEach(function (r) {
          cols.forEach(function (c) {
            var v = toNum(state.rows[r][c.idx]);
            if (v != null) maxV = Math.max(maxV, v);
          });
        });
      });
    }

    var fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    var y = 0;
    blocks.forEach(function (b) {
      ctx.fillStyle = "#1a1a1a";
      ctx.font = "600 11px " + fontStack;
      ctx.fillText(b.name + " (n=" + b.rows.length + ")", padL, y + 12);
      y += labelH;
      b.rows.forEach(function (r) {
        ctx.fillStyle = b.color;
        ctx.fillRect(yLabelW, y, bandW, rowH);
        cols.forEach(function (c, ci) {
          var cell = state.rows[r][c.idx];
          var fill = null;
          if (mode === "binary") {
            var v = toBool(cell);
            fill = v === 1 ? b.color : v === 0 ? "#e7e7e7" : null;
          } else {
            var q = toNum(cell);
            if (q != null) fill = hexToRgba(b.color, 0.12 + 0.88 * Math.min(1, q / maxV));
          }
          if (fill) {
            ctx.fillStyle = fill;
            ctx.fillRect(padL + ci * cellW, y, Math.max(1, cellW - 1), Math.max(1, rowH - (rowH > 2 ? 1 : 0)));
          }
        });
        y += rowH;
      });
      y += blockGap;
    });

    // x axis: tick values plus a title
    ctx.fillStyle = "#666";
    ctx.font = "10px " + fontStack;
    ctx.textAlign = "center";
    cols.forEach(function (c, ci) {
      ctx.fillText(c.x.toLocaleString("en-US"), padL + ci * cellW + cellW / 2, y + 10);
    });
    ctx.font = "600 11px " + fontStack;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText("Price (" + state.settings.currency + ")", padL + (wrapW - padL) / 2, y + 28);

    // y axis: rotated label along the left edge
    ctx.save();
    ctx.fillStyle = "#666";
    ctx.font = "10px " + fontStack;
    ctx.translate(10, (height - axisH) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(mode === "binary"
      ? "Respondents (sorted by breakpoint)"
      : "Respondents (sorted by average quantity)", 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
  }

  function renderBpDist() {
    var bpByRow = {};
    (results.breakpoints || []).forEach(function (b) { bpByRow[b.row] = b; });
    var maxPrice = Math.max.apply(null, results.cols.map(function (c) { return c.x; }));
    var gtCat = "> " + fmtPrice(maxPrice);

    var valSet = {};
    (results.breakpoints || []).forEach(function (b) { if (b.bp != null) valSet[b.bp] = 1; });
    var vals = Object.keys(valSet).map(Number).sort(function (a, b) { return a - b; });
    var cats = ["Never"].concat(vals.map(function (v) { return fmtPrice(v); })).concat([gtCat]);

    var groups = rasterBlocks();
    var traces = groups.map(function (g) {
      var counts = {}, n = 0;
      cats.forEach(function (c) { counts[c] = 0; });
      g.rowIdxs.forEach(function (r) {
        var b = bpByRow[r];
        if (!b) return;
        if (b.bp != null) { n++; counts[fmtPrice(b.bp)]++; }
        else if (b.category === "never purchased") { n++; counts["Never"]++; }
        else if (b.category === "purchased at all prices" ||
                 b.category === "still purchasing at highest price") { n++; counts[gtCat]++; }
        // nonsystematic / no-data / price-0 edge cases are omitted
      });
      return {
        x: cats,
        y: cats.map(function (c) { return n ? 100 * counts[c] / n : 0; }),
        type: "bar", name: g.name, marker: { color: g.color },
        hovertemplate: esc(g.name) + "<br>%{x}: %{y:.1f}%<extra></extra>"
      };
    });

    Plotly.react($("bp-dist"), traces, {
      barmode: "group",
      margin: { t: 10, r: 24, b: 80, l: 64 },
      font: { family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", color: "#1a1a1a", size: 12 },
      paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff",
      xaxis: {
        title: { text: "Breakpoint (" + state.settings.currency + ")" },
        type: "category", tickangle: -35,
        linecolor: "#1a1a1a", tickfont: { color: "#666" }
      },
      yaxis: {
        title: { text: "Respondents (%)" },
        gridcolor: "#ececec", zeroline: false,
        linecolor: "#1a1a1a", ticks: "outside", tickcolor: "#1a1a1a",
        tickfont: { color: "#666" }
      },
      showlegend: groups.length > 1,
      legend: { orientation: "h", y: 1.12, x: 0 }
    }, { responsive: true, displayModeBar: false });
  }

  /* ---------------- clean & recode step ---------------- */

  function renderClean() {
    renderDerivedList();
    renderDeriveSrcOptions();
    renderDeriveRules();
    renderFilter();
  }

  function renderDerivedList() {
    var box = $("derived-list");
    if (!state.derivedCols.length) { box.innerHTML = ""; return; }
    box.innerHTML = state.derivedCols.map(function (d) {
      return "<div class='derived-item'>“<strong>" + esc(d.name) + "</strong>” (recoded from “" + esc(d.srcName) + "”) " +
        "<button class='quiet derived-del' data-name=\"" + esc(d.name) + "\">remove</button></div>";
    }).join("");
    box.querySelectorAll(".derived-del").forEach(function (btn) {
      btn.addEventListener("click", function () { deleteDerivedColumn(btn.dataset.name); });
    });
  }

  function renderDeriveSrcOptions() {
    var sel = $("derive-src");
    var prev = sel.value;
    sel.innerHTML = "";
    state.headers.forEach(function (h, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = h;
      sel.appendChild(o);
    });
    if (prev !== "" && +prev < state.headers.length) sel.value = prev;
  }

  var deriveModeChoice = null; // user override: "values" | "ranges" | null = auto

  function parseRangeRules() {
    var rules = [];
    (($("derive-ranges") && $("derive-ranges").value) || "").split("\n").forEach(function (line) {
      var m = line.match(/^\s*(-?[\d.]+)\s*[-–]\s*(-?[\d.]+)\s*=\s*(.+)$/);
      if (m) rules.push({ lo: +m[1], hi: +m[2], label: m[3].trim() });
    });
    return rules;
  }

  function updateDerivePreview(srcIdx) {
    var el = $("derive-preview");
    if (!el) return;
    var rules = parseRangeRules();
    if (!rules.length) { el.textContent = ""; return; }
    var elseLabel = ($("derive-else") && $("derive-else").value.trim()) || "(kept as is)";
    var counts = {}, order = [];
    state.rows.forEach(function (row) {
      var v = String(row[srcIdx] == null ? "" : row[srcIdx]).trim();
      if (v === "") return;
      var n = parseFloat(v.replace(/[^\d.\-]/g, ""));
      var label = elseLabel;
      if (isFinite(n)) {
        for (var ri = 0; ri < rules.length; ri++) {
          if (n >= rules[ri].lo && n <= rules[ri].hi) { label = rules[ri].label; break; }
        }
      }
      if (!(label in counts)) { counts[label] = 0; order.push(label); }
      counts[label]++;
    });
    el.textContent = "Preview: " + order.map(function (l) {
      return l + " × " + counts[l];
    }).join(" · ");
  }

  function renderDeriveRules() {
    var i = +$("derive-src").value;
    var box = $("derive-rules");
    if (isNaN(i) || !state.headers.length) { box.innerHTML = ""; return; }
    var uniq = uniqueValues(i);

    // profile the full column (not the capped distinct list): mostly-numeric
    // columns default to range recoding
    var nums = [], nonEmpty = 0, seen = {}, distinctCount = 0;
    state.rows.forEach(function (row) {
      var v = String(row[i] == null ? "" : row[i]).trim();
      if (v === "") return;
      nonEmpty++;
      if (!seen[v]) { seen[v] = 1; distinctCount++; }
      var n = parseFloat(v.replace(/[^\d.\-]/g, ""));
      if (isFinite(n)) nums.push(n);
    });
    var numericish = nonEmpty > 0 && nums.length / nonEmpty >= 0.8;
    var tooMany = distinctCount > 30;
    var mode = deriveModeChoice ||
      (tooMany || (numericish && distinctCount > 8) ? "ranges" : "values");
    if (mode === "values" && tooMany) mode = "ranges";

    var html = "<div class='radio-row'>" +
      "<label" + (tooMany ? " title='This column has " + distinctCount + " distinct values — too many to map one by one. Use numeric ranges instead.'" : "") + ">" +
      "<input type='radio' name='derive-mode' value='values'" +
      (mode === "values" ? " checked" : "") + (tooMany ? " disabled" : "") +
      "> Map each value" + (tooMany ? " <span class='note'>(unavailable: this column has " + distinctCount + " distinct values; the limit for one-by-one mapping is 30)</span>" : "") + "</label>" +
      "<label><input type='radio' name='derive-mode' value='ranges'" +
      (mode === "ranges" ? " checked" : "") + "> Numeric ranges</label>" +
      "</div>";

    if (mode === "values") {
      html += "<p class='hint'>Give each value a new label (leave blank to keep the value unchanged):</p>" +
        "<div class='table-scroll'><table><thead><tr><th>Value</th><th>New label</th></tr></thead><tbody>";
      uniq.forEach(function (v) {
        html += "<tr><td>" + esc(v) + "</td><td><input type='text' class='derive-map' data-val=\"" + esc(v) + "\"></td></tr>";
      });
      html += "</tbody></table></div>";
    } else {
      var rangeHint = nums.length
        ? "This column's values go from " + Math.min.apply(null, nums).toLocaleString("en-US") +
          " to " + Math.max.apply(null, nums).toLocaleString("en-US") + ". "
        : "";
      html += "<p class='hint'>" + rangeHint +
        "Type one range per line as <code>lowest-highest = group name</code>. " +
        "For example, <code>18-29 = Young adult</code> puts everyone from 18 through 29 " +
        "(including both 18 and 29) into a group called “Young adult”.</p>" +
        "<textarea id='derive-ranges' rows='4' placeholder='18-29 = Young adult&#10;30-49 = Middle adult&#10;50-99 = Older adult'></textarea>" +
        "<div class='field'><label for='derive-else'>Label for values not covered by any range</label>" +
        "<input type='text' id='derive-else' placeholder='e.g. Other'>" +
        "<span class='note'>If left blank, uncovered values keep their original value.</span></div>" +
        "<p class='hint' id='derive-preview'></p>";
    }
    box.innerHTML = html;
    box.dataset.mode = mode;

    box.querySelectorAll("input[name='derive-mode']").forEach(function (r) {
      r.addEventListener("change", function () {
        if (r.checked) { deriveModeChoice = r.value; renderDeriveRules(); }
      });
    });
    if (mode === "ranges") {
      var refresh = function () { updateDerivePreview(i); };
      $("derive-ranges").addEventListener("input", refresh);
      $("derive-else").addEventListener("input", refresh);
    }
  }

  function addDerivedColumn() {
    var srcIdx = +$("derive-src").value;
    var name = ($("derive-name").value || "").trim();
    if (isNaN(srcIdx) || name === "") return;
    while (state.headers.indexOf(name) >= 0) name += "_2";

    var mapFn;
    if ($("derive-rules").dataset.mode === "values") {
      var map = {};
      $("derive-rules").querySelectorAll(".derive-map").forEach(function (inp) {
        if (inp.value.trim() !== "") map[inp.dataset.val] = inp.value.trim();
      });
      mapFn = function (v) { return map[v] != null ? map[v] : v; };
    } else {
      var rules = parseRangeRules();
      var elseLabel = ($("derive-else") && $("derive-else").value.trim()) || "";
      mapFn = function (v) {
        var n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
        if (isFinite(n)) {
          for (var ri = 0; ri < rules.length; ri++) {
            if (n >= rules[ri].lo && n <= rules[ri].hi) return rules[ri].label;
          }
        }
        return elseLabel !== "" ? elseLabel : String(v);
      };
    }

    var srcName = state.headers[srcIdx];
    state.headers.push(name);
    state.roles.push("ignore");
    state.priceVals.push(null);
    state.rows.forEach(function (row) {
      var v = String(row[srcIdx] == null ? "" : row[srcIdx]).trim();
      row.push(v === "" ? "" : mapFn(v));
    });
    state.derivedCols.push({ name: name, srcName: srcName });
    $("derive-name").value = "";
    renderClean(); scheduleSave();
  }

  function deleteDerivedColumn(name) {
    var idx = state.headers.indexOf(name);
    if (idx < 0) return;
    state.headers.splice(idx, 1);
    state.roles.splice(idx, 1);
    state.priceVals.splice(idx, 1);
    state.rows.forEach(function (row) { row.splice(idx, 1); });
    state.derivedCols = state.derivedCols.filter(function (d) { return d.name !== name; });
    if (state.settings.groupIdx === idx) state.settings.groupIdx = -1;
    else if (state.settings.groupIdx > idx) state.settings.groupIdx--;
    if (state.clean.filterCol === idx) { state.clean.filterCol = -1; state.clean.filterVals = []; }
    else if (state.clean.filterCol > idx) state.clean.filterCol--;
    renderClean(); scheduleSave();
  }

  function renderFilter() {
    var sel = $("filter-col");
    sel.innerHTML = "";
    var optNone = document.createElement("option");
    optNone.value = "-1";
    optNone.textContent = "None";
    sel.appendChild(optNone);
    state.headers.forEach(function (h, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = h;
      sel.appendChild(o);
    });
    sel.value = String(state.clean.filterCol);
    if (sel.value !== String(state.clean.filterCol)) sel.value = "-1";

    var box = $("filter-values");
    if (state.clean.filterCol < 0) {
      box.innerHTML = "";
      $("filter-summary").textContent = "";
      return;
    }
    var uniq = uniqueValues(state.clean.filterCol);
    var blanks = 0;
    state.rows.forEach(function (row) {
      var v = String(row[state.clean.filterCol] == null ? "" : row[state.clean.filterCol]).trim();
      if (v === "") blanks++;
    });
    var html = "";
    if (blanks > 0) {
      var blankChecked = state.clean.filterVals.indexOf("") >= 0 ? " checked" : "";
      html += "<label><input type='checkbox' class='filter-val' value=\"\"" + blankChecked + "> <em>(blank)</em> — " + blanks + " row(s)</label>";
    }
    html += uniq.slice(0, 40).map(function (v) {
      var checked = state.clean.filterVals.indexOf(v) >= 0 ? " checked" : "";
      return "<label><input type='checkbox' class='filter-val' value=\"" + esc(v) + "\"" + checked + "> " + esc(v) + "</label>";
    }).join("");
    box.innerHTML = html;
    box.querySelectorAll(".filter-val").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var v = cb.value;
        if (cb.checked) {
          if (state.clean.filterVals.indexOf(v) < 0) state.clean.filterVals.push(v);
        } else {
          state.clean.filterVals = state.clean.filterVals.filter(function (x) { return x !== v; });
        }
        updateFilterSummary(); scheduleSave();
      });
    });
    updateFilterSummary();
  }

  function updateFilterSummary() {
    var exc = state.rows.length - includedRowIdxs().length;
    $("filter-summary").textContent = exc > 0
      ? "Excluding " + exc + " of " + state.rows.length + " respondents."
      : "No rows excluded — check a value above to exclude rows with it.";
  }

  function downloadCleaned() {
    var priceIdx = {};
    priceColumns().forEach(function (c) { priceIdx[c.idx] = true; });
    var mode = state.settings.mode;
    var lines = [state.headers.map(function (h) { return JSON.stringify(String(h)); }).join(",")];
    includedRowIdxs().forEach(function (r) {
      lines.push(state.headers.map(function (_, i) {
        var cell = state.rows[r][i];
        var s = String(cell == null ? "" : cell);
        if (priceIdx[i]) {
          if (mode === "binary") {
            var b = toBool(cell);
            s = b === 1 ? "Yes" : b === 0 ? "No" : "";
          } else {
            var n = toNum(cell);
            s = n != null ? String(n) : "";
          }
        }
        return JSON.stringify(s);
      }).join(","));
    });
    downloadText(baseName() + "_cleaned.csv", lines.join("\n") + "\n");
  }

  function renderAggTable() {
    var series = results.series;
    var xs = results.cols.map(function (c) { return c.x; });
    var uniqueX = xs.filter(function (x, i) { return xs.indexOf(x) === i; });
    var html = "<table><thead><tr><th class='num'>Price</th>" +
      series.map(function (s) { return "<th class='num'>" + esc(s.name) + "</th>"; }).join("") +
      "</tr></thead><tbody>";
    uniqueX.forEach(function (x) {
      html += "<tr><td class='num'>" + x.toLocaleString("en-US") + "</td>";
      series.forEach(function (s) {
        var pts = s.points.filter(function (p) { return p.x === x; });
        var val = pts.length ? pts.map(function (p) { return fmtNum(p.y, 2); }).join(" / ") : "—";
        html += "<td class='num'>" + val + "</td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    $("agg-table").innerHTML = html;
  }

  /* ---------------- downloads ---------------- */

  function downloadText(name, text, type) {
    var blob = new Blob([text], { type: type || "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
  }

  function baseName() {
    return (state.fileName || "demand").replace(/\.[^.]+$/, "");
  }

  function downloadAgg() {
    if (!results || results.error) return;
    var series = results.series;
    var xs = results.cols.map(function (c) { return c.x; });
    var uniqueX = xs.filter(function (x, i) { return xs.indexOf(x) === i; });
    var lines = ["x," + series.map(function (s) { return JSON.stringify(s.name); }).join(",")];
    uniqueX.forEach(function (x) {
      var cells = [x];
      series.forEach(function (s) {
        var pts = s.points.filter(function (p) { return p.x === x; });
        cells.push(pts.length ? pts[0].y.toFixed(6) : "");
      });
      lines.push(cells.join(","));
    });
    downloadText(baseName() + "_aggregated.csv", lines.join("\n") + "\n");
  }

  function downloadResults() {
    if (!results || results.error) return;
    var lines = ["series,n,points,Q0,q0_source,alpha,k," + (results.mode === "binary" ? "p50" : "price_at_half_Q0") + ",p50_within_observed_range,pmax," + (results.mode === "binary" ? "omax_revenue_per_person" : "omax") + ",r_squared,auc"];
    results.series.forEach(function (s) {
      var f = s.fit;
      lines.push([
        JSON.stringify(s.name), s.n, s.nFitted,
        f.error ? "" : f.Q0.toFixed(6),
        f.error ? "" : (f.q0Fixed ? "fixed_at_observed_price0" : "fitted"),
        f.error ? "" : f.alpha.toExponential(8),
        f.error ? "" : f.k,
        s.p50 != null ? s.p50.toFixed(4) : "",
        s.p50 != null ? String(!!s.p50InRange) : "",
        s.pmax != null ? s.pmax.toFixed(4) : "",
        s.omax != null ? s.omax.toFixed(4) : "",
        f.error ? "" : f.rSquared.toFixed(6),
        s.auc != null ? s.auc.toFixed(6) : ""
      ].join(","));
    });
    downloadText(baseName() + "_parameters.csv", lines.join("\n") + "\n");
  }

  function downloadBreakpoints() {
    if (!results || results.error || !results.breakpoints) return;
    var gi = state.settings.groupIdx;
    var idIdx = -1;
    for (var i = 0; i < state.headers.length; i++) {
      if (state.roles[i] === "ignore" && i !== gi) { idIdx = i; break; }
    }
    var lines = ["row,respondent,group,prices_answered,reversals,systematic,category,last_yes_price,first_no_price,breakpoint"];
    results.breakpoints.forEach(function (b) {
      lines.push([
        b.row + 1,
        JSON.stringify(idIdx >= 0 ? String(state.rows[b.row][idIdx]) : ""),
        JSON.stringify(gi >= 0 ? String(state.rows[b.row][gi]) : ""),
        b.answered, b.reversals, b.systematic,
        JSON.stringify(b.category),
        b.lastYes != null ? b.lastYes : "",
        b.firstNo != null ? b.firstNo : "",
        b.bp != null ? b.bp.toFixed(4) : ""
      ].join(","));
    });
    downloadText(baseName() + "_breakpoints.csv", lines.join("\n") + "\n");
  }

  /* ---------------- wiring ---------------- */

  function goStep(n) {
    state.step = n;
    renderAll();
    scheduleSave();
  }

  function init() {
    // upload
    var dz = $("dropzone"), fi = $("file-input");
    dz.addEventListener("click", function () { fi.click(); });
    dz.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") fi.click(); });
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("dragover"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("dragover");
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener("change", function () { if (fi.files.length) { handleFile(fi.files[0]); fi.value = ""; } });
    $("sample-btn").addEventListener("click", loadSample);

    // stepper navigation
    document.querySelectorAll(".step-pill").forEach(function (p) {
      p.addEventListener("click", function () {
        var n = +p.dataset.step;
        if (n === 1 || state.fileName) goStep(n);
      });
    });

    // step 2
    document.querySelectorAll('input[name="mode"]').forEach(function (r) {
      r.addEventListener("change", function () {
        if (r.checked) { state.settings.mode = r.value; scheduleSave(); }
      });
    });
    $("group-select").addEventListener("change", function () {
      state.settings.groupIdx = +$("group-select").value;
      scheduleSave();
    });
    $("back-1").addEventListener("click", function () { goStep(2); });
    $("to-results").addEventListener("click", function () { goStep(4); });

    // step 2 (clean & recode)
    $("back-clean").addEventListener("click", function () { goStep(1); });
    $("to-map").addEventListener("click", function () { goStep(3); });
    $("dl-clean").addEventListener("click", downloadCleaned);
    $("derive-src").addEventListener("change", function () {
      deriveModeChoice = null;   // re-detect the best mode for the new column
      renderDeriveRules();
    });
    $("derive-add").addEventListener("click", addDerivedColumn);
    $("filter-col").addEventListener("change", function () {
      state.clean.filterCol = +$("filter-col").value;
      state.clean.filterVals = [];
      renderFilter(); scheduleSave();
    });

    // step 4 (results)
    $("back-2").addEventListener("click", function () { goStep(3); });
    $("currency-input").addEventListener("input", function () {
      state.settings.currency = $("currency-input").value || "₦";
      renderResults(); scheduleSave();
    });
    $("k-input").addEventListener("change", function () {
      var v = +$("k-input").value;
      if (v > 0) { state.settings.k = v; renderResults(); scheduleSave(); }
    });
    $("show-groups").addEventListener("change", function () {
      state.settings.showGroups = $("show-groups").value;
      renderResults(); scheduleSave();
    });
    $("zero-mode").addEventListener("change", function () {
      state.settings.zeroMode = $("zero-mode").value;
      renderResults(); scheduleSave();
    });
    $("show-p50-lines").addEventListener("change", function () {
      state.settings.showP50Lines = $("show-p50-lines").checked;
      renderChart(); scheduleSave();
    });
    $("show-pmax-lines").addEventListener("change", function () {
      state.settings.showPmaxLines = $("show-pmax-lines").checked;
      renderChart(); renderRevenueCurve(); scheduleSave();
    });
    $("dl-breakpoints").addEventListener("click", downloadBreakpoints);
    $("dl-raster").addEventListener("click", function () {
      $("raster").toBlob(function (blob) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = baseName() + "_individual_responses.png";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
      });
    });
    $("dl-dist").addEventListener("click", function () {
      Plotly.downloadImage($("bp-dist"), { format: "png", scale: 3, filename: baseName() + "_breakpoint_distribution" });
    });
    $("dl-revenue-png").addEventListener("click", function () {
      Plotly.downloadImage($("revenue-chart"), { format: "png", scale: 3, filename: baseName() + "_revenue_curve" });
    });
    $("revenue-details").addEventListener("toggle", function () {
      if (results && !results.error) renderRevenueCurve();
    });
    $("dl-agg").addEventListener("click", downloadAgg);
    $("dl-results").addEventListener("click", downloadResults);
    $("dl-png").addEventListener("click", function () {
      Plotly.downloadImage($("chart"), { format: "png", scale: 3, filename: baseName() + "_demand_curve" });
    });
    $("start-over").addEventListener("click", function () {
      if (confirm("Clear the current session and saved data from this browser?")) {
        clearSaved();
        location.reload();
      }
    });

    // resume
    var saved = loadSaved();
    if (saved) {
      var when = new Date(saved.savedAt);
      var desc = saved.rowsOmitted
        ? "Saved settings from “" + saved.fileName + "” were found (the dataset was too large to store — re-upload the file to continue)."
        : "You have a saved session: “" + saved.fileName + "” (" + saved.rows.length +
          " respondents), last saved " + when.toLocaleString() + ".";
      $("resume-text").textContent = desc;
      $("resume-banner").style.display = "";
      $("resume-btn").addEventListener("click", function () {
        state.fileName = saved.fileName;
        state.headers = saved.headers;
        state.rows = saved.rows || [];
        state.roles = saved.roles;
        state.priceVals = saved.priceVals;
        state.settings = saved.settings;
        if (!state.settings.zeroMode) state.settings.zeroMode = "exclude";
        if (!state.settings.hiddenGroups) state.settings.hiddenGroups = [];
        if (state.settings.showP50Lines == null) state.settings.showP50Lines = true;
        if (state.settings.showPmaxLines == null) state.settings.showPmaxLines = true;
        state.clean = saved.clean || defaultClean();
        state.derivedCols = saved.derivedCols || [];
        state.step = saved.rowsOmitted || !state.rows.length ? 1 : (saved.step || 3);
        $("resume-banner").style.display = "none";
        renderAll();
      });
      $("discard-btn").addEventListener("click", function () {
        clearSaved();
        $("resume-banner").style.display = "none";
      });
    }

    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
