# Forge Deploy

Forge is the Hermes Agent plus OpenRouter sibling runtime for adapter parity and execution diversity.

## Host Shape

- host: `dev@192.168.1.15`
- working tree: `/home/dev/agent-runtime`
- base config: `/home/dev/agent-runtime/deploy/forge/runtime.forge.json`
- host override: `~/.config/agent-runtime/forge.host.json`
- Hermes/OpenRouter env: `~/.config/agent-runtime/forge.hermes.env`
- heartbeat env: `~/.config/agent-runtime/forge.heartbeat.env`
- state root: `/home/dev/agent-runtime/deploy/forge/state`

## Bring-Up

1. Clone or sync `agent-runtime` onto the VM.
2. Run `~/.bun/bin/bun install`.
3. Copy `deploy/forge/runtime.forge.host.example.json` to `~/.config/agent-runtime/forge.host.json`.
4. Create `~/.config/agent-runtime/forge.hermes.env` from `deploy/forge/forge.hermes.env.example` and store the real OpenRouter key only on the host.
5. Create `~/.config/agent-runtime/forge.heartbeat.env` from `deploy/forge/forge.heartbeat.env.example`.
6. Run:

```bash
~/.bun/bin/bunx tsc --noEmit
~/.bun/bin/bun test
~/.bun/bin/bun run src/cli.ts healthcheck --config ~/.config/agent-runtime/forge.host.json
```

7. Enable services:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/agent-runtime-*.service deploy/systemd/agent-runtime-*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-operator@forge.service
systemctl --user enable --now agent-runtime-dispatch@forge.timer
```

## First Proofs

Seed `backlog/forge.seed.json`, then verify:

- default Hermes/OpenRouter adapter proof
- credential store readiness artifact
- AIBTC wallet and identity readiness artifact
- heartbeat task runs through the `aibtc-heartbeat` script adapter and records a normal task attempt
