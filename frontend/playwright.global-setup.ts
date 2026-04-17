import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "18000"
const postgresPort = process.env.PLAYWRIGHT_POSTGRES_PORT ?? "55432"
const composeProjectName =
  process.env.PLAYWRIGHT_COMPOSE_PROJECT ?? "mriqc-aggregator-e2e"
const databaseUrl =
  process.env.PLAYWRIGHT_DATABASE_URL ??
  `postgresql+psycopg://mriqc:mriqc@localhost:${postgresPort}/mriqc_aggregator`

function composeEnv() {
  return {
    ...process.env,
    API_PORT: apiPort,
    POSTGRES_PORT: postgresPort,
    COMPOSE_PROJECT_NAME: composeProjectName,
    MRIQC_DATABASE_URL: databaseUrl,
  }
}

function run(command: string, args: string[]) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: composeEnv(),
    stdio: "inherit",
  })
}

async function waitFor(url: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the service is reachable.
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error(`Timed out waiting for ${url}`)
}

export default async function globalSetup() {
  run("docker", ["compose", "down", "-v"])
  run("docker", ["compose", "up", "--build", "-d", "--wait"])
  await waitFor(`http://127.0.0.1:${apiPort}/api/v1/health`)
  run("pixi", ["run", "db-init"])
  run("pixi", ["run", "python", "scripts/seed_dashboard_fixture.py"])
}
