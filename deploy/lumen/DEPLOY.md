# Lumen Proving Deploy

This is the first live proving deployment for Lumen.

The deployment rule is strict:

- install `agent-runtime` beside the current Hermes tree
- do not mutate `~/.hermes/hermes-agent`
- keep Lumen's scope narrow: GitHub story summaries and Discord interactions only

## Target Host

- host: `dev@192.168.1.16`
- working tree suggestion: `/home/dev/agent-runtime`
- config: `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json`

## Provisioning Steps

1. Copy `agent-runtime/` to `/home/dev/agent-runtime`.
2. Create the Lumen state directories:
   - `/home/dev/agent-runtime/deploy/lumen/state`
   - `/home/dev/agent-runtime/deploy/lumen/state/logs`
   - `/home/dev/agent-runtime/deploy/lumen/state/artifacts`
3. Install Bun for the `dev` user if it is missing:

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
~/.bun/bin/bun --version
```

4. Run:
   - `cd /home/dev/agent-runtime`
   - `~/.bun/bin/bun install`
   - `bunx tsc --noEmit`
   - `bun test`
   - `bun run src/cli.ts healthcheck --config deploy/lumen/runtime.lumen.json`

## First Manual Bring-Up

Before enabling any timer:

1. Queue one known-safe GitHub story task:

```bash
cd /home/dev/agent-runtime
bun run src/cli.ts bridge-github --file fixtures/github-pr-merged.json --config deploy/lumen/runtime.lumen.json
```

2. Run one manual cycle:

```bash
bun run src/cli.ts run-once --config deploy/lumen/runtime.lumen.json
```

3. Inspect:

```bash
bun run src/cli.ts status --config deploy/lumen/runtime.lumen.json
tail -n 20 deploy/lumen/state/logs/runtime.jsonl
```

Only enable the timer after this manual cycle completes cleanly.

4. Queue one known-safe Discord reply task:

```bash
bun run src/cli.ts bridge-discord --file fixtures/discord-mention.json --config deploy/lumen/runtime.lumen.json
bun run src/cli.ts run-once --config deploy/lumen/runtime.lumen.json
```

## Systemd Units

Install these files under `~/.config/systemd/user/`:

- `agent-runtime-run-once@.service`
- `agent-runtime-dispatch@.timer`
- `agent-runtime-operator@.service`

Template instance for Lumen:

- service instance name: `lumen`
- config path environment: `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json`

Enable the timer:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-dispatch@lumen.timer
systemctl --user status agent-runtime-dispatch@lumen.timer
```

Enable the operator dashboard separately:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-operator@lumen.service
systemctl --user status agent-runtime-operator@lumen.service
curl http://127.0.0.1:4314/api/status
```

The dashboard is read-only and serves:

- static operator UI at `/`
- status JSON at `/api/status`
- aggregate operator view at `/api/dashboard`
- workflow, task, event, artifact, snapshot, and snapshot-report reads under `/api/*`
- SSE updates at `/api/stream`

## Rollback

1. Stop the timer:
   - `systemctl --user stop agent-runtime-dispatch@lumen.timer`
2. Stop any in-flight service:
   - `systemctl --user stop agent-runtime-run-once@lumen.service`
   - `systemctl --user stop agent-runtime-operator@lumen.service`
3. Keep `deploy/lumen/state/logs/` for inspection.
4. Move the proving runtime out of the way or restore the previous tree.
5. Do not touch the existing Hermes service unless the proving runtime explicitly replaced it later.

## Exit Condition For “Lumen Is Fired Up”

Lumen counts as fired up when all of the following are true:

- `healthcheck` passes on the Lumen host
- one manual GitHub story task completes successfully
- one manual Discord reply task completes successfully
- timer is enabled and completes at least one unattended cycle without retry/backoff anomalies
- current Hermes installation remains intact beside the proving runtime
