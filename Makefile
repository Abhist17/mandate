.PHONY: help install build test coverage fmt snapshot deploy-testnet keeper keeper-sim web indexer demo seed clean

FOUNDRY := $(HOME)/.foundry/bin
export PATH := $(FOUNDRY):$(PATH)

# Contract addresses live in .env and are read by the keeper, the scripts, and the web build.
# Exporting them here means `make web` picks up a fresh deploy without a manual `source`.
ifneq (,$(wildcard .env))
include .env
export
endif

# firstword, not MAKEFILE_LIST: including .env above puts it in the list too, and awk would
# then print "Makefile"/".env" as the target name for every line.
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies (forge libs + node workspaces)
	cd contracts && forge install
	npm install

build: ## Compile contracts
	cd contracts && forge build

test: ## Run the Foundry test suite
	cd contracts && forge test -vv

test-gas: ## Run tests with a gas report
	cd contracts && forge test --gas-report

coverage: ## Line coverage report (target >90% on RiskEngine + MandateRegistry)
	cd contracts && forge coverage --report summary

fmt: ## Format Solidity
	cd contracts && forge fmt

snapshot: ## Gas snapshot
	cd contracts && forge snapshot

deploy-testnet: ## Deploy the full system to Monad testnet
	cd contracts && forge script script/Deploy.s.sol:Deploy \
		--rpc-url $$MONAD_TESTNET_RPC --broadcast --legacy -vvv

keeper: ## Run the risk keeper against the deployed contracts
	npm run keeper

keeper-sim: ## Drive a mandate through a price path into a breach
	npm run keeper:simulate

web: ## Run the frontend dev server
	npm run web

web-build: ## Production build of the frontend
	cd web && npx next build

indexer: ## Run the Envio HyperIndex indexer
	cd indexer && npx envio dev

seed: ## Seed the deployed system with mandates in mixed states
	npm run seed

demo: ## The money shot: healthy mandate -> adverse move -> breach -> flatten
	npm run demo

spike: ## Re-verify the Phase 1 claims against live Perpl and Pyth endpoints
	npx tsx scripts/spike-perpl.ts

smoke: ## Render the app in a real browser and fail on any console error
	node scripts/smoke-web.mjs

verify: build test typecheck web-build ## Everything CI runs, locally
	@echo "\033[32mAll checks passed.\033[0m"

typecheck: ## Typecheck the keeper and the frontend
	npx tsc --noEmit -p keeper/tsconfig.json
	cd web && npx tsc --noEmit

clean: ## Remove build artefacts
	cd contracts && forge clean
	rm -rf web/.next keeper/dist
