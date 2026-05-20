# ⚠️ Dependency Warning

Dependencies are pinned to `"latest"` in `package.json`.
This means any breaking change in Elysia will instantly break production.

**Action required:**
1. Run `bun install` and note the exact versions installed
2. Update `package.json` with exact versions (e.g. `"1.2.3"`)
3. Add a `bun.lockb` lockfile and commit it
4. Enable Dependabot in `.github/dependabot.yml`
