# agent-runtime

Minimum runnable shared runtime extracted from the Phase 2 contract.

This proof keeps the runtime intentionally small:

- explicit task intake
- deterministic context assembly
- adapter-based execution
- SQLite persistence
- dispatch lock plus retry handling
- CLI operator visibility

## Commands

Install a local config first:

```bash
cp config/runtime.example.json config/runtime.json
```

Queue a task:

```bash
bun run src/cli.ts intake --json '{
  "kind": "github-story",
  "source": "github",
  "priority": 5,
  "payload": {
    "repo": "aibtcdev/agent-runtime",
    "summary": "Summarize what this PR means for operators"
  },
  "requested_profile": "lumen"
}'
```

Run one dispatch cycle:

```bash
bun run src/cli.ts run-once
```

Inspect runtime status:

```bash
bun run src/cli.ts status
```

Run health checks:

```bash
bun run src/cli.ts healthcheck
```

Run tests:

```bash
bun test
```

Create a workflow:

```bash
bun run src/cli.ts workflow-create \
  --template community-research \
  --instance_key lumen-community-wiki \
  --context '{"slug":"lumen-community-wiki","topic":"AIBTC community wiki","output_path":"community-wiki/aibtc-basics.md"}'
```

Inspect workflows:

```bash
bun run src/cli.ts workflow-list
bun run src/cli.ts workflow-show --instance_key lumen-community-wiki
```

Advance a workflow explicitly:

```bash
bun run src/cli.ts workflow-transition --id 1 --state draft-community-wiki-outline
```

Lumen proving deploy artifacts:

```text
deploy/lumen/runtime.lumen.json
deploy/lumen/DEPLOY.md
deploy/systemd/agent-runtime-run-once@.service
deploy/systemd/agent-runtime-dispatch@.timer
deploy/systemd/agent-runtime-operator@.service
```

Run the operator dashboard:

```bash
bun run src/web.ts --config config/runtime.json --host 127.0.0.1 --port 4314
```

Dashboard surfaces:

- `/` static operator view
- `/api/status` runtime status and last event
- `/api/dashboard` combined operator payload
- `/api/workflows`, `/api/tasks`, `/api/events`
- `/api/artifacts`, `/api/artifact`
- `/api/snapshots`, `/api/snapshot`, `/api/report`, `/api/report/latest`
- `/api/stream` live SSE updates

Queue a Lumen GitHub task through the thin bridge:

```bash
bun run src/cli.ts bridge-github --file fixtures/github-pr-merged.json
```

Queue a Lumen Discord task through the thin bridge:

```bash
bun run src/cli.ts bridge-discord --file fixtures/discord-mention.json
```

## Layout

```text
agent-runtime/
  config/
  profiles/
  src/
  state/
```

The runtime does not include Discord business logic, GitHub polling, Arc identity, Loom publishing, or Forge fleet UI work. Those belong in thin bridges or later migrations.
