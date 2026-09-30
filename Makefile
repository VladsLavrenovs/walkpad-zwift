# Laptop helpers. `make update` after pulling changes to the bridge laptop.
.PHONY: update test

update:  ## git pull, install deps, build web, restart the bridge service if bridge code changed
	./scripts/update.sh

test:  ## both test suites
	cd bridge && uv run pytest -q
	cd web && npm test
