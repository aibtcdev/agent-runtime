# Spark Deploy

Spark is the Claude Code subscription sibling runtime for implementation-heavy work.

## Host Shape

- host: `dev@192.168.1.12`
- working tree: `/home/dev/agent-runtime`
- base config: `/home/dev/agent-runtime/deploy/spark/runtime.spark.json`
- host override: `~/.config/agent-runtime/spark.host.json`
- heartbeat env: `~/.config/agent-runtime/spark.heartbeat.env`
- state root: `/home/dev/agent-runtime/deploy/spark/state`

## Bring-Up

1. Clone or sync `agent-runtime` onto the VM.
2. Run `~/.bun/bin/bun install`.
3. Copy `deploy/spark/runtime.spark.host.example.json` to `~/.config/agent-runtime/spark.host.json`.
4. Edit the host override after Claude Code subscription auth is available.
5. Create `~/.config/agent-runtime/spark.heartbeat.env` from `deploy/spark/spark.heartbeat.env.example`.
6. Run:

```bash
~/.bun/bin/bunx tsc --noEmit
~/.bun/bin/bun test
~/.bun/bin/bun run src/cli.ts healthcheck --config ~/.config/agent-runtime/spark.host.json
```

7. Enable services:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/agent-runtime-*.service deploy/systemd/agent-runtime-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-operator@spark.service
systemctl --user enable --now agent-runtime-dispatch@spark.timer
```

## First Proofs

Seed `backlog/spark.seed.json`, then verify:

- default Claude subscription adapter proof
- credential store readiness artifact
- AIBTC wallet and identity readiness artifact
- heartbeat task runs through the `aibtc-heartbeat` script adapter and records a normal task attempt
