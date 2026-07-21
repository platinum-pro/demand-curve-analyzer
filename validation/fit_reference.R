# Reference fits using the exact settings from the user's analysis script:
# nls, algorithm = "port", start alpha=1e-7 Qo=100, bounds alpha [0,0.1],
# Qo [0,100], maxiter 50000; P50 via uniroot within the observed price range.
# Run from the project root: Rscript validation/fit_reference.R

k_global <- 2
Koff <- function(x, alpha, Qo, k_fixed) {
  Qo * 10^(k_fixed * (exp(-alpha * Qo * x) - 1))
}

calculate_p50 <- function(alpha, Qo, k_fixed, data, target_q = 50) {
  if (alpha <= 0 || Qo <= 0 || k_fixed <= 0) return(NA)
  objective_function <- function(price) {
    Qo * 10^(k_fixed * (exp(-alpha * Qo * price) - 1)) - target_q
  }
  if (Koff(0, alpha, Qo, k_fixed) < target_q) return(NA)
  lower_bound <- min(data$x[data$x > 0], na.rm = TRUE)
  upper_bound <- max(data$x, na.rm = TRUE)
  if (objective_function(lower_bound) * objective_function(upper_bound) > 0) return(NA)
  result <- tryCatch(
    uniroot(objective_function, interval = c(lower_bound, upper_bound), tol = 0.01),
    error = function(e) NULL
  )
  if (!is.null(result)) result$root else NA
}

files <- list.files("validation", pattern = "^agg_test[0-9]+\\.csv$", full.names = TRUE)
out <- data.frame()
for (f in files) {
  data <- read.csv(f)
  valid_data <- data[!is.na(data$All) & data$x > 0, ]
  fit <- nls(All ~ Koff(x, alpha, Qo, k_global),
             data = valid_data,
             start = list(alpha = 0.0000001, Qo = 100),
             algorithm = "port",
             lower = c(alpha = 0, Qo = 0),
             upper = c(alpha = 0.1, Qo = 100),
             control = nls.control(maxiter = 50000))
  res <- residuals(fit)
  tss <- sum((valid_data$All - mean(valid_data$All))^2)
  r2 <- 1 - sum(res^2) / tss
  p <- coef(fit)
  p50 <- calculate_p50(p["alpha"], p["Qo"], k_global, valid_data)
  out <- rbind(out, data.frame(file = basename(f),
                               alpha = p["alpha"], Q0 = p["Qo"],
                               r_squared = r2, rss = sum(res^2), p50 = p50))
}
write.csv(out, "validation/r_results.csv", row.names = FALSE)
print(out, digits = 10)
