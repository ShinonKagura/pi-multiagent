# hb-orchestra Cookbook

Task-oriented recipes for the hb-orchestra persona/Agent/Profile surface. Each recipe references the
runnable example files under [`examples/`](../examples). For the lower-level detached `agent_team`
graph patterns, see [`skills/pi-multiagent/references/graph-cookbook.md`](../skills/pi-multiagent/references/graph-cookbook.md)
and [`examples/graphs/`](../examples/graphs) (18 graph examples).

Example assets used below:
- Personas: [`examples/agents/`](../examples/agents) — `reviewer`, `scout`, `worker`, `docs-writer`, `summarizer`.
- Profiles: [`examples/profiles/`](../examples/profiles) — `analyze-then-review`, `cross-model-review`, `scout-then-review`.
- Harness: [`examples/harness/contract.json`](../examples/harness/contract.json).

---

## 1. Simple Agent (one persona, read-only)
Delegate a single read-only persona and get the answer inline.
```
/agent reviewer "review src/auth/login.ts"
Agent({ subagent_type: "reviewer", prompt: "review src/auth/login.ts", waitSeconds: 120 })
```
Persona: `examples/agents/reviewer.md`.

## 2. Detached delegation + collect later
The default returns a `runId` immediately; collect the result when ready.
```
const { runId } = Agent({ subagent_type: "scout", prompt: "map the files a rate-limit change touches" })
get_subagent_result({ runId, waitSeconds: 30 })
```

## 3. Multi-model parallel (same task, several models)
Run one task across models and compare.
```
/profile cross-model-review "review this diff"
Profile({ profile: "cross-model-review", task: "review this diff", waitSeconds: 90 })
```
Profile: `examples/profiles/cross-model-review.json` (parallel, 3 models).

## 4. Chain with artifact handoff
Step 1's artifact feeds step 2.
```
/profile scout-then-review "plan a null-safety fix in the auth module"
Profile({ profile: "analyze-then-review", task: "analyze and review the payment refactor", waitSeconds: 120 })
```
Profiles: `examples/profiles/scout-then-review.md`, `examples/profiles/analyze-then-review.md`.

## 5. Persona / model override at call time
Override the persona's model or tools for one call.
```
Agent({ subagent_type: "reviewer", model: "openai/gpt-5.5", tools: ["read", "grep"],
        prompt: "security-focused review of src/auth/" })
```
The persona's `fallbackModels` still apply if the chosen model fails (see `examples/agents/scout.md`).

## 6. Worktree-isolated mutation (safe writes)
Mutating runs must declare a `mutationScope`; isolate them in a throwaway git worktree.
```
Agent({ subagent_type: "worker",
        prompt: "add a null check before the session lookup",
        mutationScope: "edit allowed under src/auth/",
        isolation: "worktree" })
```
Persona: `examples/agents/worker.md`. Substrate graph: `examples/graphs/worktree-isolated-mutation.json`.

## 7. Scheduled / recurring delegation
Schedule an Agent run via the `schedule` field (cron / interval / one-shot), or wire external
cron to an `agent_team start`.
```
Agent({ subagent_type: "summarizer", prompt: "summarize today's changelog",
        schedule: "0 9 * * 1" })   // every Monday 09:00
```

## 8. Reproduce a past run
Every run has a deterministic `run_hash`; re-launch the identical graph.
```
/replay <run_hash>
Replay({ runId: "<run_hash>", waitSeconds: 60 })
```

## 9. Governed delegation (harness contract)
Drop a read-only contract at `.pi/harness/contract.json` (see `examples/harness/contract.json`).
A mutating run whose `mutationScope` targets a `forbiddenPath` is blocked (`harness-policy-denied`),
and the path/scope policy is injected into the child prompt.
```
// With forbiddenPaths: ["src/legacy/"] in the contract:
Agent({ subagent_type: "worker", prompt: "...", mutationScope: "edit under src/legacy/auth" })
// -> blocked: harness policy restriction
```

## 10. Steer a live run
```
steer_subagent({ runId: "<id>", message: "focus on error handling, skip style nits" })
```

## 11. Drive hb-orchestra from another extension (RPC)
```ts
pi.events.on("subagents:rpc:reply", (r) => { /* { id, method, ok, result?|error? } */ });
pi.events.emit("subagents:rpc:spawn", { id: "1", params: { graph: { /* agent_team start graph */ } } });
```
See [`docs/API.md`](./API.md) §9 for the full RPC contract.

---

_See [`docs/API.md`](./API.md) for the frozen contract, [`docs/USING-HB-ORCHESTRA.md`](./USING-HB-ORCHESTRA.md)
for day-to-day usage, and [`docs/MIGRATION-FROM-PI-SUBAGENTS.md`](./MIGRATION-FROM-PI-SUBAGENTS.md) to migrate._
