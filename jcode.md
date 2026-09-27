# jcode: Rust coding-agent server, swarm DAG and memory

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: master, commit `8556d6fcce610f06018947c0449420b24884b33f`. Focused audit of server ownership, multi-client sessions, swarm design and published memory measurements.

## HLD

jcode is a native Rust TUI plus a long-lived local server. The server owns provider/MCP configuration and sessions; the UI is a client. A frontend can autostart a detached `jcode serve` process, communicate over a per-user Unix socket and reconnect with backoff after server restart. The project also documents a multi-agent swarm/task-graph design and persistent memory/retrieval components.

## LLD and task/session model

The server architecture centralizes session and provider state so multiple client surfaces can attach without each owning an independent agent runtime. Session/client architecture describes multiple sessions and reconnect behavior. Swarm planning represents work as a dependency DAG with tasks, status, dependencies, acceptance gates and depth/mode choices (including “deep” and “light” paths). The swarm DAG is identified by the project docs as still being implemented; the older swarm architecture is marked largely implemented, and migration from the earlier shared-context/message design is staged. Do not treat every document section as shipped behavior.

Memory includes a persistent graph/retrieval concept, extraction and embedding/RAG helpers. The exact memory is advisory context; it must be checked for repository revision, provenance and staleness before driving edits.

## RAM claim and method boundary

The README reports project-measured Linux PSS from ten interactive PTY launches. It lists approximately 27.8 MB for the baseline without local embeddings, around 167.1 MB for a configured jcode session, and approximately 9.9 MB additional PSS per session in the measured configuration. Embedding-enabled configuration consumes more. These are project-reported April 2026 measurements, not independent September 2026 results; PSS is not RSS, and listed versions/hardware/process boundaries affect the comparison. The figures are not “total jcode uses only 9.9 MB.”

For a fair HorizonCode comparison, pin OS/build/model/backend, embeddings, warm/cold caches, session count, PTY/client/server processes, and report peak/steady PSS and RSS over the entire process tree.

## Reliability questions

- Which state is durable in server vs client, and what is the recovery contract after server or machine failure?
- Are task transitions and events transactional with task artifacts and workspace commit IDs?
- Can two clients claim the same task/session writer? How are leases fenced?
- Does the swarm DAG currently enforce dependency completion and independent acceptance gates, or are some controls still roadmap?
- Is extracted memory invalidated when source files or branch change?

## Relevance to HorizonCode

Study the lean local server/client split and multi-session reconnect model, then measure memory independently. Borrow task-DAG concepts only after confirming which enforcement is implemented. HorizonCode needs durable run/task state, workspace lease fencing and verification records regardless of the UI or server restart behavior.

## Primary references

[README and PSS methodology](https://github.com/1jehuang/jcode) · [Server architecture](https://github.com/1jehuang/jcode/blob/master/docs/SERVER_ARCHITECTURE.md) · [Swarm architecture](https://github.com/1jehuang/jcode/blob/master/docs/SWARM_ARCHITECTURE.md) · [Task graph](https://github.com/1jehuang/jcode/blob/master/docs/SWARM_TASK_GRAPH.md) · [Multi-session clients](https://github.com/1jehuang/jcode/blob/master/docs/MULTI_SESSION_CLIENT_ARCHITECTURE.md)
