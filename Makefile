.PHONY: build release install uninstall clean help

BINARY_NAME := tiguclaw
INSTALL_DIR := /usr/local/bin

## build: Debug build
build:
	cargo build

## release: Release build
release:
	cargo build --release

## install: Build release and install to /usr/local/bin
install: release
	@echo "Installing $(BINARY_NAME) to $(INSTALL_DIR)..."
	@if [ -w "$(INSTALL_DIR)" ]; then \
		cp target/release/$(BINARY_NAME) $(INSTALL_DIR)/$(BINARY_NAME); \
	else \
		sudo cp target/release/$(BINARY_NAME) $(INSTALL_DIR)/$(BINARY_NAME); \
	fi
	@echo "✅ Installed: $$($(INSTALL_DIR)/$(BINARY_NAME) --version)"

## uninstall: Remove binary from /usr/local/bin
uninstall:
	@if [ -f "$(INSTALL_DIR)/$(BINARY_NAME)" ]; then \
		if [ -w "$(INSTALL_DIR)" ]; then \
			rm $(INSTALL_DIR)/$(BINARY_NAME); \
		else \
			sudo rm $(INSTALL_DIR)/$(BINARY_NAME); \
		fi; \
		echo "✅ Uninstalled $(BINARY_NAME)"; \
	else \
		echo "$(BINARY_NAME) not found in $(INSTALL_DIR)"; \
	fi

## clean: Remove build artifacts
clean:
	cargo clean

## help: Show this help
help:
	@grep -E '^## ' Makefile | sed 's/## /  /'
