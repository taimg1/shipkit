import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"

/**
 * Deliberately small: the fixture exists to prove the adapter runs the project's linter and
 * fails the stage when it complains, not to demonstrate a rule set. A client project brings
 * its own config — the kit never supplies one.
 */
export default defineConfig([
  globalIgnores([".next/**", "next-env.d.ts"]),
  ...tseslint.configs.recommended,
])
