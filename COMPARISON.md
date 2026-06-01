# Agent Comparison: Baseline vs. Improved

This document compares the two agent implementations in `src_baseline/` and `src/`. Both follow the BDI (Beliefs-Desires-Intentions) architecture, but the improved version replaces several heuristic shortcuts with principled, model-driven decisions.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Beliefs](#2-beliefs)
3. [Pathfinding: BFS → A\*](#3-pathfinding-bfs--a)
4. [Intention revision: Replace → Revise](#4-intention-revision-replace--revise)
5. [Utility function](#5-utility-function)
6. [Options generation](#6-options-generation)
7. [Exploration: uniform random → Gaussian KDE sampling](#7-exploration-uniform-random--gaussian-kde-sampling)
8. [Opportunistic pickup during movement](#8-opportunistic-pickup-during-movement)
9. [Agent awareness](#9-agent-awareness)
10. [Summary table](#10-summary-table)

---

## 1. Architecture overview

Both agents are structured as BDI loops, sharing the same four-plan library (`GoPickUp`, `GoDeliver`, `BfsMove`/`AstarMove`, `Explore`), the same socket event wiring, and the same `IntentionDeliberation` class for executing a single intention. The differences are entirely in how beliefs are maintained, how intentions are scored and ordered, and how pathfinding is performed.

```
socket events ──► Belief Revision
                       │
                  optionsGeneration()
                       │ push(predicate)
               IntentionRevision.push()
                       │
            [IntentionRevisionReplace]         ← baseline
            [IntentionRevisionRevise ]         ← improved
                       │
               intention_queue (sorted)
                       │
             IntentionRevision.loop()
                       │
             IntentionDeliberation.achieve()
                       │
                  Plan.execute()
```

---

## 2. Beliefs

### Baseline (`src_baseline/beliefs.js`)

| Belief | Type | Purpose |
|---|---|---|
| `me` | object | Own position and score |
| `mapBeliefs` | `Map<string, tile>` | Known tile types |
| `deliveryTiles` | `{x,y}[]` | Delivery zone locations |
| `spawnTiles` | `{x,y}[]` | Parcel spawn locations |
| `parcels` | `Map<id, parcel>` | Visible parcels |
| `temporaryBlocks` | `Map<key, timestamp>` | Tiles blocked after a failed move |

### Improved (`src/beliefs.js`)

Everything above, plus:

| Belief | Type | Purpose |
|---|---|---|
| `agents` | `Map<id, agent>` | Other visible agents (used for competition avoidance) |
| `spawnWeights` | `Map<key, number>` | KDE density weight for each spawn tile |
| `gameConfig` | object | Full server configuration received on connect |

`gameConfig` is the most impactful addition. It exposes the server's clock speed, parcel decay schedule, observation distance, and player capacity. The improved agent uses all four to replace every hardcoded threshold in the baseline.

---

## 3. Pathfinding: BFS → A\*

### Baseline: Breadth-First Search

BFS expands nodes in FIFO order, guaranteeing the shortest path on unweighted grids. However, it explores in all directions without any hint of where the target is.

```
queue = [ start ]
while queue not empty:
    node = queue.shift()          // FIFO — explores radially
    for each neighbor:
        if not visited: queue.push(neighbor)
```

Worst-case nodes expanded: **O(W × H)** — the entire reachable map.

### Improved: A\* with a Manhattan heuristic

A\* keeps the open set in a **min-heap** keyed by the evaluation function:

$$f(n) = g(n) + h(n)$$

where:
- $g(n)$ — exact cost (number of steps) from start to $n$
- $h(n) = |n_x - t_x| + |n_y - t_y|$ — Manhattan distance to target $t$

Because the grid is unweighted and movement is axis-aligned, the Manhattan heuristic is **admissible** (never overestimates) and **consistent**, so A\* finds the optimal path while expanding far fewer nodes than BFS on open maps.

```
open = MinHeap{ start, g=0, f=h(start) }
gScore[start] = 0

while open not empty:
    node = open.pop()             // smallest f — biased toward target
    if node == target: return path
    for each neighbor:
        ng = node.g + 1
        if ng < gScore[neighbor]:
            gScore[neighbor] = ng
            open.push({ neighbor, g: ng, f: ng + h(neighbor) })
```

A path-free variant `astarDistance` is also provided for use in utility scoring, avoiding the overhead of building the path array when only the distance is needed.

**Why it matters:** On large or sparse maps BFS wastes time expanding tiles that are clearly going in the wrong direction. A\* prunes those branches early, reducing the per-step planning cost and making the agent more responsive.

---

## 4. Intention revision: Replace → Revise

### Baseline: `IntentionRevisionReplace`

Every call to `push()` stops whatever is running and discards the entire queue:

```js
async push(predicate) {
    const last = this.intention_queue.at(-1);
    if (last && last.predicate.join(' ') == predicate.join(' ')) return;
    const intention = new IntentionDeliberation(this, predicate);
    if (last) last.stop();
    this.intention_queue.length = 0;   // wipe everything
    this.intention_queue.push(intention);
}
```

This is reactive to the extreme: every sensing event (which fires multiple times per second) can interrupt an in-progress delivery. The agent thrashes between intentions because it re-evaluates only the single best option visible at that moment.

### Improved: `IntentionRevisionRevise`

`push()` adds the new intention to a **priority queue sorted by utility**, then preempts the current intention only if something strictly better has risen to the top:

```js
async push(predicate) {
    const utility = this.getUtility(predicate);
    if (utility < 0) return;                // reject invalid intentions

    if (/* duplicate */) return;

    this.intention_queue.push(new IntentionDeliberation(this, predicate));

    const currentTop = this.intention_queue[0];
    this.intention_queue.sort((a, b) =>
        this.getUtility(b.predicate) - this.getUtility(a.predicate)
    );
    const newTop = this.intention_queue[0];

    if (currentTop !== newTop && !currentTop.stopped) {
        currentTop.stop();
        this.intention_queue.splice(index, 1);
    }

    // prune now-invalid entries
    for (let i = queue.length - 1; i >= 0; i--)
        if (this.getUtility(queue[i].predicate) < 0) { stop; splice; }
}
```

Key properties:

- **No thrashing** — the agent keeps executing its current plan unless something provably better appears.
- **Queue continuity** — after a delivery the agent immediately starts the next best pickup without waiting for the next sensing event.
- **Automatic invalidation** — when a parcel is picked up by someone else, the `go_pick_up` entry for it scores `< 0` on the next revision and is pruned.

---

## 5. Utility function

The utility function is the core of the improved agent's deliberation. All intentions are ranked on a single comparable scale.

Sum of utilities of all parcels being delivered, where utility of each parcel is max(0, reward - decayPerStep * dist)


### Delivery utility

$$U_{\text{deliver}}(d) = \sum_{p \in \text{carried}} (max\left(0, p.\text{reward} - \text{dist}(\text{me}, d) \cdot \delta\right)) + \frac{\sigma_r}{2}$$

where:
- $\text{dist}(\text{me}, d)$ — A\* distance to delivery tile $d$
- $\delta = \dfrac{T_\text{clock}}{T_\text{decay}}$ — reward lost per step of travel (decay rate)
- $\sigma_r$ — `reward_variance` (a small bonus that makes delivery preferred over a zero-reward pickup)

The decay rate $\delta$ is derived at runtime:

```js
const decayIntervalMs = parseMs(gameConfig.GAME.parcels.decaying_event);
const decayPerStep    = gameConfig.CLOCK / decayIntervalMs;
```

For example, if the clock ticks every 50 ms and parcels decay every 1 s, then $\delta = 50/1000 = 0.05$ reward units per step.

### Pickup utility

$$U_{ \text{pickup} }(p, d^{\ast}) = \sum_{ q \in \text{carried} \cup \lbrace p \rbrace } (max\left(0, q.\text{reward} - (\text{dist}(\text{me}, p) + \text{dist}(p, d^{\ast})) \cdot \delta \right))$$

where $d^{\ast}$ is the nearest delivery tile from the pickup location $p$.

This models the **full round-trip cost**: the agent must walk from its current position to $p$, then from $p$ to the nearest delivery. All carried parcels (not just the new one) decay for that entire journey, so the formula correctly accounts for the opportunity cost of detours.

### Baseline comparison

The baseline uses a simpler, ad-hoc score only for sorting candidates within `optionsGeneration`, with no consistent scale across action types:

```js
// Baseline pickup score — reward density, no decay model
score = parcel.reward / (distance(me, parcel) + 1)
```

This score cannot be compared to the delivery priority (which is just hardcoded as "deliver first if carrying anything and no pickup is within 10 tiles").

### Explore utility

$$U_{\text{explore}} = 0$$

Exploration is always valid but always ranked last. Any pickup or delivery with positive net value outranks it.

---

## 6. Options generation

### Baseline

One call produces at most one intention, replacing everything:

```
if carrying AND delivery exists:
    if best pickup is within 10 tiles AND carrying < 9:
        push go_pick_up(best)     ← hardcoded thresholds
        return
    push go_deliver(nearest)
    return
if best pickup exists:
    push go_pick_up(best)
    return
push explore
```

Problems:
- Thresholds `10` (distance) and `9` (capacity) are hardcoded, ignoring actual game config.
- `reward > 10` filter also hardcoded.
- Only one option is considered at a time; the utility comparison between deliver and pickup is not principled.

### Improved

Options generation proposes **all** valid options simultaneously and lets the utility system rank them:

```js
// Always propose delivery if carrying
if (carried.length > 0 && deliveryTiles.length > 0)
    myAgent.push(['go_deliver', nearestDelivery.x, nearestDelivery.y]);

// Propose every unclaimed parcel within sensor range,
// unless at capacity or a visible competitor is strictly closer
if (carried.length < gameConfig.GAME.player.capacity) {
    for (const p of available) {
        const closerAgentExists = agents.some(a => distance(a, p) < distance(me, p));
        if (!closerAgentExists)
            myAgent.push(['go_pick_up', p.x, p.y, p.id]);
    }
}

// Always propose explore as fallback
myAgent.push(['explore']);
```

The utility function then selects and orders these proposals. The options generator does not need to know the thresholds — they emerge from the decay model.

---

## 7. Exploration: uniform random → Gaussian KDE sampling

### Baseline

Picks uniformly at random from spawn tiles that are more than 2 tiles away:

```js
const farSpawns = spawnTiles.filter(t => distance(me, t) > 2);
target = farSpawns[Math.floor(Math.random() * farSpawns.length)];
```

This wastes moves on isolated spawn tiles that rarely produce parcels.

### Improved: Parzen window (Gaussian KDE)

The map update handler computes a **kernel density estimate** over the known spawn tiles. Each spawn tile $s_i$ receives a weight proportional to how many other spawn tiles are nearby:

$$w(s_i) = \sum_{j} \exp\!\left(-\frac{\|s_i - s_j\|^2}{2h^2}\right)$$

where $h$ is `observation_distance` (the server-provided sensor range), used as the KDE bandwidth.

This collapses to uniform weights when spawn tiles cover more than 1/3 of the map (a dense map needs no bias).

During exploration, each candidate tile's final sampling weight combines two factors:

$$\text{weight}(t) = w(t) \cdot \exp\!\left(-\frac{\|t - \text{me}\|^2}{2h^2}\right)$$

- $w(t)$ — KDE score: prefer **dense spawn clusters** (more likely to generate parcels)
- The second factor — prefer **closer** destinations (lower opportunity cost to get there)

Sampling is then performed with `weightedRandom`, a linear-scan alias sampler.

**Why KDE works here:** Parcel generation is tied to spawn tiles, and game maps often concentrate spawns in specific regions. The KDE identifies those hot-spots. The proximity weight prevents the agent from committing to a distant cluster when a nearby one is equally dense.

---

## 8. Opportunistic pickup during movement

The improved `BfsMove.execute()` (which now calls `astar` internally) checks for unclaimed parcels at every new tile the agent lands on:

```js
const { x: newX, y: newY } = result;   // confirmed position from server
const carried = parcels.filter(p => p.carriedBy === me.id);
if (carried.length < gameConfig.GAME.player.capacity) {
    const parcelOnTile = parcels.some(
        p => !p.carriedBy && round(p.x) === round(newX) && round(p.y) === round(newY)
    );
    if (parcelOnTile) await socket.emitPickup();
}
```

This costs zero additional moves. The baseline only calls `emitPickup()` at the explicit target tile of a `GoPickUp` plan.

---

## 9. Agent awareness

The baseline has no model of other agents. The improved agent tracks all visible competitors in the `agents` map (updated on every sensing event) and uses this to avoid contesting parcels it is likely to lose:

```js
const closerAgentExists = Array.from(agents.values()).some(
    a => distance(a, p) < distance(me, p)
);
if (!closerAgentExists) myAgent.push(['go_pick_up', p.x, p.y, p.id]);
```

This is a conservative policy: it only suppresses proposals where another agent is **strictly** closer. It prevents the agent from wasting steps racing to a parcel it cannot reach first, freeing it to pursue others.

---

## 10. Summary table

| Aspect | Baseline (`src_baseline`) | Improved (`src`) |
|---|---|---|
| **Pathfinding** | BFS (FIFO queue) | A\* with Manhattan heuristic + MinHeap |
| **Intention revision** | `Replace` — wipes queue on every push | `Revise` — sorts by utility, preempts only if better |
| **Utility model** | None (ad-hoc priority rules) | Decay-aware reward–cost formula per action type |
| **Decay awareness** | None | $\delta = T_\text{clock} / T_\text{decay}$, from game config |
| **Delivery utility** | Always highest priority (hardcoded) | $\Sigma\,p.\text{reward} - \text{dist} \cdot \delta + \sigma_r/2$ |
| **Pickup utility** | Reward-density score $r/(d+1)$ | Full round-trip decay: $\Sigma\,q.\text{reward} - (d_1+d_2)\cdot\delta$ |
| **Options generation** | Single best option per event | All valid options; utility ranks them |
| **Capacity threshold** | Hardcoded `< 9` | `< gameConfig.GAME.player.capacity` |
| **Reward filter** | Hardcoded `> 10` | `> gameConfig.GAME.parcels.reward_variance` |
| **Exploration target** | Uniform random over far spawn tiles | KDE-weighted spawn tiles biased toward dense clusters and proximity |
| **Opportunistic pickup** | No | Yes — on every movement step |
| **Other agents** | Not modelled | Tracked; parcels with a closer competitor are skipped |
| **Game config** | Ignored | Fully consumed via `onConfig` |
| **Tile block duration** | 3 s | 1 s (faster recovery) |
