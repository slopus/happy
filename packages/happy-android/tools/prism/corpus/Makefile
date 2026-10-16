# comment
CC ?= gcc
CFLAGS := -O2 -Wall
.PHONY: all clean
all: build/app
build/%.o: src/%.c
	$(CC) $(CFLAGS) -c $< -o $@
clean:
	rm -rf build $(wildcard *.tmp)
