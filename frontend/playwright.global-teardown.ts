import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export default async function globalTeardown() {
  execFileSync("docker", ["compose", "down", "-v"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      API_PORT: process.env.PLAYWRIGHT_API_PORT ?? "18000",
      POSTGRES_PORT: process.env.PLAYWRIGHT_POSTGRES_PORT ?? "55432",
      COMPOSE_PROJECT_NAME:
        process.env.PLAYWRIGHT_COMPOSE_PROJECT ?? "mriqc-aggregator-e2e",
    },
    stdio: "inherit",
  })
}
