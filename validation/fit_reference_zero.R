# Reference fits for the two zero-price modes, using the same nls settings
# as the main analysis script:
#  - include: the price-0 row enters the fit as an ordinary data point
#  - fix: Q0 is fixed at the observed price-0 demand; only alpha is fitted
#    (on the positive-price rows)
# Run from the project root: Rscript validation/fit_reference_zero.R

k_global <- 2
Koff <- function(x, alpha, Qo, k_fixed) {
  Qo * 10^(k_fixed * (exp(-alpha * Qo * x) - 1))
}

files <- list.files("validation", pattern = "^agg_testz[0-9]+\\.csv$", full.names = TRUE)
out <- data.frame()
for (f in files) {
  data <- read.csv(f)
  data <- data[!is.na(data$All), ]
  zero_y <- data$All[data$x == 0][1]
  pos_data <- data[data$x > 0, ]

  # include mode: all rows, both parameters free
  fit_inc <- nls(All ~ Koff(x, alpha, Qo, k_global),
                 data = data,
                 start = list(alpha = 0.0000001, Qo = 100),
                 algorithm = "port",
                 lower = c(alpha = 0, Qo = 0),
                 upper = c(alpha = 0.1, Qo = 100),
                 control = nls.control(maxiter = 50000))
  r_inc <- residuals(fit_inc)
  r2_inc <- 1 - sum(r_inc^2) / sum((data$All - mean(data$All))^2)
  p_inc <- coef(fit_inc)

  # fix mode: Q0 pinned to observed zero-price demand, alpha-only fit
  Qo_fixed <- zero_y
  fit_fix <- nls(All ~ Koff(x, alpha, Qo_fixed, k_global),
                 data = pos_data,
                 start = list(alpha = 0.0000001),
                 algorithm = "port",
                 lower = c(alpha = 0),
                 upper = c(alpha = 0.1),
                 control = nls.control(maxiter = 50000))
  r_fix <- residuals(fit_fix)
  r2_fix <- 1 - sum(r_fix^2) / sum((pos_data$All - mean(pos_data$All))^2)
  a_fix <- coef(fit_fix)

  out <- rbind(out, data.frame(file = basename(f),
                               alpha_inc = p_inc["alpha"], Q0_inc = p_inc["Qo"],
                               r2_inc = r2_inc, rss_inc = sum(r_inc^2),
                               Q0_fixed = Qo_fixed,
                               alpha_fix = a_fix["alpha"],
                               r2_fix = r2_fix, rss_fix = sum(r_fix^2)))
}
write.csv(out, "validation/r_results_zero.csv", row.names = FALSE)
print(out, digits = 10)
