# comment
library(dplyr)
greet <- function(name = "World", times = 2L) {
  msg <- paste0("Hello, ", name, "!")
  for (i in seq_len(times)) print(msg)
  invisible(TRUE)
}
df %>% filter(x > 1.5e3) %>% summarise(n = n())
