# =====================================================================
# Demand Curve Analyzer — R companion script
# Reproduces the full analysis pipeline of https://analyzer.promiselabs.africa/
# on your own machine: aggregation, exponentiated-model fitting
# (Koffarnus, Franck, Stein & Bickel, 2015), P50, individual breakpoints,
# and the demand-curve figure.
#
# Usage: edit the Configuration block, then
#   Rscript r/analyzer_companion.R
# =====================================================================

# ---------------- Configuration ----------------
input_file    <- "sample_hpt_data.csv"
response_mode <- "binary"    # "binary" (yes/no) or "quantity" (units)
group_col     <- "sex"       # column name for group comparisons, or NA
k_global      <- 2           # span constant, fixed globally
currency      <- "₦"    # used in printed output and the figure
zero_mode     <- "exclude"   # price-0 handling: "exclude" | "include" | "fix"
out_dir       <- "."         # where CSV/PNG outputs are written

# ---------------- Model ----------------
Koff <- function(x, alpha, Qo, k) Qo * 10^(k * (exp(-alpha * Qo * x) - 1))

# Closed-form price at which predicted demand equals `target`
# (algebraic inversion of the model; NA when the curve never crosses it)
p_at_target <- function(alpha, Qo, k, target) {
  if (!is.finite(alpha) || alpha <= 0 || Qo <= 0 || k <= 0 || Qo <= target) return(NA)
  rhs <- 1 + log10(target / Qo) / k
  if (rhs <= 0) return(NA)
  -log(rhs) / (alpha * Qo)
}

# Principal branch of the Lambert W function (Newton iteration), for Pmax
lambert_w0 <- function(x) {
  if (!is.finite(x) || x < -exp(-1)) return(NA)
  w <- if (x < 1) x else log(x)
  for (i in 1:100) {
    ew <- exp(w)
    w_next <- w - (w * ew - x) / (ew * (1 + w))
    if (!is.finite(w_next)) return(NA)
    if (abs(w_next - w) < 1e-13) return(w_next)
    w <- w_next
  }
  w
}

# Pmax: exact unit-elasticity solution (Gilroy et al., 2019):
# Pmax = -W0(-1 / (k ln 10)) / (alpha * Q0); NA when k <= e/ln10
p_max <- function(alpha, Qo, k) {
  if (!is.finite(alpha) || alpha <= 0 || Qo <= 0 || k <= 0) return(NA)
  w <- lambert_w0(-1 / (k * log(10)))
  if (!is.finite(w)) return(NA)
  -w / (alpha * Qo)
}

# Area under the curve: a model-free summary of overall demand intensity,
# computed from the raw aggregated (x, y) pairs -- never the fitted curve.
# Adapts Myerson, Green, & Warusawitharana's (2001) trapezoidal AUC method
# to price data: demand (y) is normalized to its own maximum, as in the
# original method, but price (x) is normalized on a LOG10 scale (min-max
# between the lowest and highest price tested) rather than linearly -- HPT
# price grids are conventionally log-spaced, and linear normalization lets
# the (usually enormous) gap between the two highest prices dominate the
# total area. A price-0 point cannot be log-transformed and is always
# excluded -- a fixed property of the method, not a per-dataset condition.
# Bounded [0, 1]. NA if fewer than 2 valid positive-price points, or all
# prices are equal.
auc_index <- function(x, y) {
  keep <- is.finite(x) & x > 0 & is.finite(y)
  x <- x[keep]; y <- y[keep]
  if (length(x) < 2) return(NA)
  ord <- order(x)
  x <- x[ord]; y <- y[ord]
  lx <- log10(x)
  lx_min <- lx[1]; lx_max <- lx[length(lx)]
  y_max <- max(y)
  if (!(lx_max > lx_min) || !(y_max > 0)) return(NA)
  xn <- (lx - lx_min) / (lx_max - lx_min); yn <- y / y_max
  sum(diff(xn) * (head(yn, -1) + tail(yn, -1)) / 2)
}

# ---------------- Data loading ----------------
data <- read.csv(input_file, check.names = FALSE, fileEncoding = "UTF-8")

# Price columns are auto-detected: any header containing a number
# (last number wins, so "price_100", "X100", "₦100" all work)
parse_price <- function(h) {
  m <- regmatches(h, gregexpr("[0-9]+\\.?[0-9]*", gsub("[,\\s]", "", h)))[[1]]
  if (length(m) == 0) NA else as.numeric(m[length(m)])
}
prices_all <- vapply(names(data), parse_price, numeric(1))
price_cols <- names(data)[!is.na(prices_all) & prices_all >= 0]
prices     <- prices_all[price_cols]
ord        <- order(prices)
price_cols <- price_cols[ord]
prices     <- prices[ord]

to_bool <- function(cell) {
  s <- tolower(trimws(as.character(cell)))
  ifelse(s %in% c("1", "yes", "y", "true", "t"), 1,
         ifelse(s %in% c("0", "no", "n", "false", "f"), 0, NA))
}
to_num <- function(cell) suppressWarnings(as.numeric(gsub("[^0-9.\\-]", "", as.character(cell))))

# ---------------- Aggregation ----------------
aggregate_rows <- function(rows) {
  vapply(price_cols, function(cl) {
    cells <- data[[cl]][rows]
    if (response_mode == "binary") {
      b <- to_bool(cells)
      if (all(is.na(b))) NA else 100 * mean(b, na.rm = TRUE)
    } else {
      v <- to_num(cells)
      if (all(is.na(v))) NA else mean(v, na.rm = TRUE)
    }
  }, numeric(1))
}

series <- list(All = seq_len(nrow(data)))
if (!is.na(group_col) && group_col %in% names(data)) {
  for (g in sort(unique(trimws(as.character(data[[group_col]]))))) {
    series[[g]] <- which(trimws(as.character(data[[group_col]])) == g)
  }
}

agg <- data.frame(x = prices)
for (nm in names(series)) agg[[nm]] <- aggregate_rows(series[[nm]])

# ---------------- Fitting (mirrors the site exactly) ----------------
fit_series <- function(agg_col) {
  d <- data.frame(x = agg$x, All = agg_col)
  d <- d[!is.na(d$All), ]
  pos  <- d[d$x > 0, ]
  zero <- d[d$x == 0, ]
  observed0 <- if (nrow(zero)) mean(zero$All) else NA

  # AUC is independent of the fit and of zero_mode -- always computed from
  # the full aggregated series `d` (auc_index itself excludes any price-0
  # point, since log10(0) is undefined).
  auc <- auc_index(d$x, d$All)

  max_y <- max(d$All)
  upper <- if (response_mode == "binary") c(alpha = 0.1, Qo = 100)
           else c(alpha = 1, Qo = max(10, max_y * 5))

  if (zero_mode == "fix" && is.finite(observed0) && observed0 > 0) {
    Qo_fixed <- observed0
    fit <- nls(All ~ Koff(x, alpha, Qo_fixed, k_global),
               data = pos, start = list(alpha = 1e-7),
               algorithm = "port", lower = c(alpha = 0),
               upper = c(alpha = unname(upper["alpha"])),
               control = nls.control(maxiter = 50000))
    alpha <- coef(fit)[["alpha"]]; Qo <- Qo_fixed
    fit_data <- pos; q0_source <- "fixed_at_observed_price0"
  } else {
    fit_data <- if (zero_mode == "include" && nrow(zero)) d else pos
    fit <- nls(All ~ Koff(x, alpha, Qo, k_global),
               data = fit_data, start = list(alpha = 1e-7, Qo = 100),
               algorithm = "port",
               lower = c(alpha = 0, Qo = 0), upper = upper,
               control = nls.control(maxiter = 50000))
    alpha <- coef(fit)[["alpha"]]; Qo <- coef(fit)[["Qo"]]
    q0_source <- "fitted"
  }

  rss <- sum(residuals(fit)^2)
  r2  <- 1 - rss / sum((fit_data$All - mean(fit_data$All))^2)

  target <- if (response_mode == "binary") 50 else Qo / 2
  p50 <- p_at_target(alpha, Qo, k_global, target)
  p50_in_range <- if (is.na(p50)) NA else (p50 >= min(d$x) && p50 <= max(d$x))

  pmax <- p_max(alpha, Qo, k_global)
  # Omax: value of demand at Pmax. Binary data -> expected revenue per
  # person (purchase rate x price); quantity data -> conventional peak
  # spending per person (predicted units x price).
  #
  # For binary data, Koff() returns Q on a 0-100 percentage scale (the same
  # scale as the "All" column in the aggregated data), so it must be divided
  # by 100 to become a probability before multiplying by price -- revenue
  # at price P is P * Q(P)/100, not P * Q(P). Multiplying by the raw
  # percentage number instead would give a total across however many people
  # that percentage happens to be "out of," rather than an unambiguous
  # per-person figure; dividing by 100 first is what lets the result scale
  # cleanly to any group size (e.g. multiplying by 10,000 to project revenue
  # for a target population of that size).
  omax <- if (is.na(pmax)) NA else {
    q_at_pmax <- Koff(pmax, alpha, Qo, k_global)
    pmax * (if (response_mode == "binary") q_at_pmax / 100 else q_at_pmax)
  }

  list(alpha = alpha, Qo = Qo, k = k_global, q0_source = q0_source,
       r_squared = r2, p50 = p50, p50_in_range = p50_in_range,
       pmax = pmax, omax = omax, auc = auc,
       n_points = nrow(fit_data))
}

fits <- lapply(names(series), function(nm) c(list(series = nm, n = length(series[[nm]])),
                                             fit_series(agg[[nm]])))

params <- do.call(rbind, lapply(fits, function(f) {
  data.frame(series = f$series, n = f$n, points = f$n_points,
             Q0 = f$Qo, q0_source = f$q0_source, alpha = f$alpha, k = f$k,
             p50 = f$p50, p50_within_observed_range = f$p50_in_range,
             pmax = f$pmax, omax = f$omax, r_squared = f$r_squared,
             auc = f$auc)
}))

# ---------------- Individual breakpoints (binary data only) ----------------
# Adapted from Stein et al. (2015): systematic when <= 2 reversals (adjacent
# No -> Yes transitions across ascending prices). Breakpoint = geometric mean
# of the last "Yes" price and the first "No" price THAT FOLLOWS it (the
# terminal transition to rejection).
breakpoints <- NULL
if (response_mode == "binary") {
  bp_row <- function(r) {
    b <- to_bool(vapply(price_cols, function(cl) as.character(data[[cl]][r]), character(1)))
    keep <- !is.na(b); b <- b[keep]; x <- prices[keep]
    if (length(b) == 0)
      return(data.frame(row = r, answered = 0, reversals = NA, systematic = NA,
                        category = "no data", last_yes = NA, first_no_after = NA, breakpoint = NA))
    reversals <- if (length(b) > 1) sum(b[-length(b)] == 0 & b[-1] == 1) else 0
    systematic <- reversals <= 2
    last_yes_i <- if (any(b == 1)) max(which(b == 1)) else NA
    first_no_after <- if (!is.na(last_yes_i) && last_yes_i < length(b)) {
      after <- which(b == 0 & seq_along(b) > last_yes_i)
      if (length(after)) x[min(after)] else NA
    } else NA
    last_yes <- if (!is.na(last_yes_i)) x[last_yes_i] else NA

    category <- if (!systematic) "nonsystematic (excluded)"
      else if (all(b == 1)) "purchased at all prices"
      else if (all(b == 0)) "never purchased"
      else if (is.na(first_no_after)) "still purchasing at highest price"
      else if (last_yes > 0) "breakpoint"
      else "no computable breakpoint (price 0 involved)"

    bp <- if (category == "breakpoint") sqrt(last_yes * first_no_after) else NA
    data.frame(row = r, answered = length(b), reversals = reversals,
               systematic = systematic, category = category,
               last_yes = last_yes, first_no_after = first_no_after, breakpoint = bp)
  }
  breakpoints <- do.call(rbind, lapply(seq_len(nrow(data)), bp_row))
  if (!is.na(group_col) && group_col %in% names(data))
    breakpoints$group <- trimws(as.character(data[[group_col]]))
}

# ---------------- Outputs ----------------
write.csv(agg, file.path(out_dir, "aggregated_data.csv"), row.names = FALSE)
write.csv(params, file.path(out_dir, "fitted_parameters.csv"), row.names = FALSE)
if (!is.null(breakpoints))
  write.csv(breakpoints, file.path(out_dir, "individual_breakpoints.csv"), row.names = FALSE)

cat("=== Fitted parameters (zero_mode =", zero_mode, ") ===\n")
print(params, digits = 6, row.names = FALSE)

if (!is.null(breakpoints)) {
  cat("\n=== Individual breakpoints ===\n")
  for (nm in names(series)) {
    sub <- breakpoints[breakpoints$row %in% series[[nm]], ]
    v <- sub$breakpoint[!is.na(sub$breakpoint)]
    cat(sprintf("%-10s n=%d  with breakpoint=%d  median=%s%.1f  mean=%s%.1f  nonsystematic=%d\n",
                nm, nrow(sub), length(v),
                currency, median(v), currency, mean(v),
                sum(sub$category == "nonsystematic (excluded)")))
  }
}

# ---------------- Figure (requires ggplot2) ----------------
if (requireNamespace("ggplot2", quietly = TRUE)) {
  library(ggplot2)
  palette <- c("#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834")
  cols <- setNames(palette[seq_along(series)], names(series))

  pos_x   <- agg$x[agg$x > 0]
  has_zero <- any(agg$x == 0)
  pseudo_x <- min(pos_x) / 10   # price 0 plotted here, axis tick labeled "0"

  pts <- do.call(rbind, lapply(names(series), function(nm)
    data.frame(series = nm, x = ifelse(agg$x == 0, pseudo_x, agg$x), y = agg[[nm]])))

  curve_x <- 10^seq(log10(if (has_zero) pseudo_x else min(pos_x)), log10(max(pos_x)), length.out = 200)
  curves <- do.call(rbind, lapply(fits, function(f)
    data.frame(series = f$series, x = curve_x, y = Koff(curve_x, f$alpha, f$Qo, f$k))))

  ticks <- 10^seq(floor(log10(min(pos_x))), ceiling(log10(max(pos_x))))
  tick_vals   <- if (has_zero) c(pseudo_x, ticks) else ticks
  tick_labels <- if (has_zero) c("0", format(ticks, big.mark = ",", scientific = FALSE))
                 else format(ticks, big.mark = ",", scientific = FALSE)

  p <- ggplot() +
    geom_line(data = curves, aes(x = x, y = y, color = series), linewidth = 0.8) +
    geom_point(data = pts, aes(x = x, y = y, color = series), size = 2.4) +
    scale_color_manual(values = cols, breaks = names(series)) +
    scale_x_log10(breaks = tick_vals, labels = tick_labels) +
    labs(x = paste0("Price (", currency, ")"),
         y = if (response_mode == "binary") "Respondents purchasing (%)" else "Mean consumption",
         color = NULL,
         caption = if (has_zero) "Price 0 is shown at an arbitrary position on the log-scaled axis." else NULL) +
    theme_minimal() +
    theme(panel.grid = element_blank(),
          axis.line = element_line(color = "black"),
          legend.position = "top")
  if (response_mode == "binary")
    p <- p + geom_hline(yintercept = 50, linetype = "dotted", color = "grey50")
  for (f in fits) if (!is.na(f$p50) && isTRUE(f$p50_in_range))
    p <- p + geom_vline(xintercept = f$p50, linetype = "dashed", color = cols[[f$series]], alpha = 0.7)

  ggsave(file.path(out_dir, "demand_curves.png"), p, width = 8, height = 5.5, dpi = 300)
  cat("\nFigure written to demand_curves.png\n")

  # Revenue curve (Pmax/Omax): price x predicted demand, per series. Stops
  # once predicted demand falls below 3% of Q0 and never exceeds the
  # highest price tested -- see analyzer_companion's p_max comment / the
  # site's Methods page for why (the model's demand floor makes revenue
  # appear to rise again at extreme prices otherwise).
  rev_curves <- do.call(rbind, lapply(fits, function(f) {
    if (is.na(f$pmax)) return(NULL)
    obs_min <- min(pos_x); obs_max <- max(pos_x)
    target <- 0.03 * f$Qo
    rhs <- 1 + log10(target / f$Qo) / f$k
    cutoff <- if (rhs <= 0) obs_max else -log(rhs) / (f$alpha * f$Qo)
    end_p <- min(cutoff, obs_max)
    if (end_p <= obs_min) return(NULL)
    rx <- 10^seq(log10(obs_min), log10(end_p), length.out = 200)
    # /100 converts Koff()'s 0-100 percentage scale to a probability before
    # multiplying by price -- see the omax comment above for why.
    ry <- rx * (if (response_mode == "binary") Koff(rx, f$alpha, f$Qo, f$k) / 100 else Koff(rx, f$alpha, f$Qo, f$k))
    data.frame(series = f$series, x = rx, y = ry)
  }))

  if (!is.null(rev_curves) && nrow(rev_curves) > 0) {
    peak_pts <- do.call(rbind, lapply(fits, function(f) {
      if (is.na(f$pmax) || is.na(f$omax)) return(NULL)
      data.frame(series = f$series, x = f$pmax, y = f$omax)
    }))
    p2 <- ggplot(rev_curves, aes(x = x, y = y, color = series)) +
      geom_line(linewidth = 0.8) +
      geom_point(data = peak_pts, aes(x = x, y = y, color = series), size = 3) +
      scale_color_manual(values = cols, breaks = names(series)) +
      scale_x_log10() +
      labs(x = paste0("Price (", currency, ")"),
           y = if (response_mode == "binary") paste0("Expected revenue (", currency, "/person)")
               else paste0("Spending (", currency, "/person)"),
           color = NULL) +
      theme_minimal() +
      theme(panel.grid = element_blank(),
            axis.line = element_line(color = "black"),
            legend.position = "top")
    ggsave(file.path(out_dir, "revenue_curve.png"), p2, width = 8, height = 5.5, dpi = 300)
    cat("Figure written to revenue_curve.png\n")
  }
} else {
  cat("\n(ggplot2 not installed — skipping the figure.)\n")
}
