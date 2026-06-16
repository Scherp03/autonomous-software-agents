# autonomous-software-agents

Autonomous Agents developed to play a delivery-style game against other agents, developed by Professor Marco Robol for the Autonomous Software Agents master course.

## Agents

Four agent implementations, all built on the same BDI skeleton (`beliefs.js`, `agent.js`, `plans.js`, `pathfinding.js`, `index.js`, `utils.js`):

**`src_baseline/`** — reference BDI agent used for comparison. Uses `IntentionRevisionReplace`: the new intention always preempts the current one, with no utility scoring.

**`src_bdi/`** — improved BDI agent. Uses `IntentionRevisionRevise`: intentions are scored with a utility function (reward minus decay cost), sorted by priority, and the current plan is only interrupted when a strictly better option appears. Also includes KDE-weighted exploration and a PDDL-based crate puzzle solver.

**`src_llm/`** — extends the BDI agent with a natural-language interface. Listens to in-game chat and routes commands through a Planner → Executor → Final Answer ReAct loop (LiteLLM-compatible endpoint) that mutates agent rules at runtime (forbidden tiles, delivery multipliers, stack rules, etc.). Coordinates with the slave agent via shared JSON files.

**`src_slave/`** — a second agent that runs alongside `src_llm/`. It receives commands from the LLM agent through `slave-command.json` and reports status through `slave-status.json`. Supports coordinated missions (neighborhood rendezvous, edge visits, parcel handoff).

---

## Run

Requires a `.env` file (see `.env.example`).

```bash
npm install
```

```bash
npm run bdi        # final BDI agent
npm run baseline   # baseline simple BDI agent (single instance)
npm run baselines  # one baseline instance per TOKEN_N in .env
npm run llm        # BDI + LLM (requires LITELLM_* vars)
npm run slave      # slave agent, run alongside llm
```
