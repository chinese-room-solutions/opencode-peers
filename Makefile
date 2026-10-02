# opencode-peers build system
#
# Cross-session messaging plugin for opencode (TypeScript, plain tsc).
# Recipes wrap the npm scripts (AGENTS.md: use npm run build / typecheck /
# test / dry-run, not ad-hoc tsc).
#
# Usage: make <target>

NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
TGZ     := $(NAME)-$(VERSION).tgz

.PHONY: build watch typecheck test package publish clean help

# Installs dependencies on first build (fresh clones have no node_modules).
node_modules/.bin/tsc:
	npm install

build: node_modules/.bin/tsc
	@echo "==> Compiling (tsc → dist/)..."
	npm run build

watch: node_modules/.bin/tsc
	@echo "==> Watching TypeScript sources (tsc --watch)..."
	npm run build -- --watch

typecheck: node_modules/.bin/tsc
	@echo "==> Type-checking without emitting..."
	npm run typecheck

# Phony must win over the tests/ directory of the same name.
test: node_modules/.bin/tsc
	@echo "==> Testing (build + node --test suites)..."
	npm test

package: build
	@echo "==> Packaging $(TGZ)..."
	npm pack
	@echo "    Built: $(TGZ)"

publish:
	@echo "==> Publishing $(NAME) $(VERSION) to npm..."
	npm publish

clean:
	rm -rf dist *.tgz
	@echo "Cleaned."

help:
	@echo ""
	@echo "  opencode-peers build"
	@echo "  Usage: make <target>"
	@echo ""
	@echo "    build      Compile TypeScript (dist/)"
	@echo "    watch      Recompile on change (tsc --watch)"
	@echo "    typecheck  Type-check without emitting"
	@echo "    test       Build, run the full test suite (npm test)"
	@echo "    package    Build and pack $(TGZ)"
	@echo "    publish    Publish $(NAME) $(VERSION) to npm"
	@echo "    clean      Remove dist/ and *.tgz"
	@echo ""
