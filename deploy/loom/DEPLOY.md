# Loom Deploy — RFC 0010 Phase 1

This is the first agent-runtime deployment for Loom, installed as a Hermes-pair alongside the paused arc-starter.

## Target Host

- host: `dev@192.168.1.14`
- working tree: `/home/dev/agent-runtime`
- config: `/home/dev/agent-runtime/deploy/loom/runtime.loom.json`
- host override (optional): `/home/dev/.config/agent-runtime/loom.host.json`
- state root: `/home/dev/agent-runtime/deploy/loom/state/`

## Identity Continuity

Loom's on-chain addresses must survive this migration unchanged.

- Bitcoin Taproot: `bc1ptqmds7ghh5lqexzd34xnf5sryxzjvlvuj2eetmhgjkp998545tequsd9we`
- Stacks: `SP1KGHF33817ZXW27CG50JXWC0Y6BNXAQ4E7YGAHM`

Verify before signoff: the arc-starter snapshot SHA is in `/home/dev/arc-starter/README.LEGACY.md`.

## Pre-Deploy Checklist

- [ ] arc-starter timers disabled: arc-dispatch.timer, arc-sensors.timer, arc-web.service, arc-watchdog.timer
- [ ] arc-starter snapshot SHA committed and recorded in README.LEGACY.md
- [ ] agent-runtime cloned to /home/dev/agent-runtime
- [ ] state directories created
- [ ] `bun install` succeeded
- [ ] `bunx tsc --noEmit` passes
- [ ] `bun run src/cli.ts healthcheck --config deploy/loom/runtime.loom.json` passes

## Provisioning Steps

```bash
# 1. Clone
git clone https://github.com/aibtcdev/agent-runtime.git /home/dev/agent-runtime
cd /home/dev/agent-runtime

# 2. Install deps
~/.bun/bin/bun install

# 3. Verify compile
~/.bun/bin/bunx tsc --noEmit

# 4. Create state dirs
mkdir -p deploy/loom/state/logs deploy/loom/state/artifacts

# 5. Configure OpenRouter env
mkdir -p ~/.config/agent-runtime
# Create ~/.config/agent-runtime/loom.openrouter.env with:
# ANTHROPIC_API_KEY=<openrouter key>
# ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1

# 6. Healthcheck
~/.bun/bin/bun run src/cli.ts healthcheck --config deploy/loom/runtime.loom.json

# 7. Manual cycle
~/.bun/bin/bun run src/cli.ts run-once --config deploy/loom/runtime.loom.json
```

## State Directory Layout

```
deploy/loom/
  state/
    runtime.db        — task/attempt/bundle DB
    dispatch.lock     — single-dispatch lock
    logs/
      runtime.jsonl   — append-only event log
    artifacts/        — managed output artifacts
```

State dirs are separate from arc-starter's `/home/dev/arc-starter/db/`. No shared state.

## Systemd Units

Install from `deploy/systemd/` templates:

```bash
cp deploy/systemd/agent-runtime-run-once@.service ~/.config/systemd/user/
cp deploy/systemd/agent-runtime-dispatch@.timer ~/.config/systemd/user/
cp deploy/systemd/agent-runtime-operator@.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-dispatch@loom.timer
systemctl --user enable --now agent-runtime-operator@loom.service
```

## Exit Condition For "Loom Is Fired Up"

- `healthcheck` passes on `192.168.1.14`
- One manual task completes through `hermes-openrouter` adapter
- State dirs exist and are separate from arc-starter
- Timer enabled and completes one unattended cycle
- arc-starter timers remain disabled
- Identity addresses unchanged

## Rollback

1. `systemctl --user stop agent-runtime-dispatch@loom.timer`
2. Re-enable arc-starter: `systemctl --user enable --now arc-dispatch.timer arc-sensors.timer arc-web.service`
3. State in `deploy/loom/state/` is preserved — do not delete
