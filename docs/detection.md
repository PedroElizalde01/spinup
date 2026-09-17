# Detection

When a project has no `.spinup.yml`, spinup scans it and writes one. Scanning reads
files; the only command it runs is `docker compose config`, which starts nothing.
Every generated command records why it was chosen, and `--doctor` shows the same for
a fresh scan.

## Order

1. **The project's own dev command.** An executable `bin/dev`, the entries of
   `Procfile.dev` (except `release`), or a `dev` recipe, target or task in
   `justfile`, `Makefile`, `Taskfile.yml` or `mise.toml`. It runs alone, because it
   already starts what the project needs. Other launchers found are listed as notes.
2. **A monorepo's root `dev` script**, which is its orchestrator.
3. **Each project in the repository.** Declared workspaces (`workspaces` in
   `package.json`, `pnpm-workspace.yaml`, with `!` exclusions) or, without a
   declaration, the directories under `apps/`, `services/`, `packages/` and
   `crates/`.
4. **Compose**, as a single `docker compose up`.

When nothing runnable is found, spinup asks for the command in a terminal and fails
elsewhere. It never writes a guess.

## What counts as runnable

| Stack | Evidence | Command |
|---|---|---|
| Node | `dev`, `start:dev`, `develop`, `serve` or `start` script; `server.js`; `index.js` with Express or Fastify | `npm run dev`, `pnpm dev`, `yarn dev`, `bun run dev`, `node server.js` |
| Python | `manage.py`; `app = FastAPI()` or `app = Flask()` in source | `python3 manage.py runserver`, `uvicorn module:app --reload`, `flask --app module:app run --debug`, through `uv run`, `poetry run` or `.venv/bin` when the project uses them |
| Go | `.air.toml`; `package main` at the root or in `cmd/<name>` | `air`, `go run .`, `go run ./cmd/<name>` |
| Rust | `[package]` with `src/main.rs` or `[[bin]]` tables | `cargo run`, `cargo run --bin <name>` |
| Ruby | `bin/rails`; `config.ru` with a `Gemfile` | `bin/rails server`, `bundle exec rackup` |
| PHP | `artisan`; `public/index.php` with `composer.json` | `php artisan serve`, `php -S localhost:8000 -t public` |
| Java, Kotlin | Spring Boot or Quarkus plugin in Gradle or Maven | `./gradlew bootRun`, `./mvnw spring-boot:run`, `quarkusDev`, `quarkus:dev` |
| Deno | `tasks.dev` in `deno.json` | `deno task dev` |
| Compose | `compose.yaml`, `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` | `docker compose up` |

`test` and `check` scripts, library packages, library crates and plain builds are
never treated as something to run.

## Details

- **Package manager:** `packageManager` in `package.json` wins over lockfiles; a
  disagreement is reported.
- **Compose:** spinup follows Compose's own file precedence, applies the override
  file and leaves services behind a profile optional. Without the Docker CLI it
  reads the files itself and says that `include`, `extends` and interpolation were
  not resolved.
- **Names:** services with the same name get their runtime (`app-node`,
  `app-python`) or path (`apps-api`, `services-api`) added.
- **Dependencies:** services depend on the Compose service when there is one, and
  `web`, `frontend` or `client` depend on `api`, `server` or `backend`.
