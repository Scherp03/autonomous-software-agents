import "dotenv/config";
import OpenAI from "openai";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ADMIN_ID, ADMIN_NAME, dynamicRules, mapBeliefs, me, parcels, handoffState, mapWidthxHeight } from "./beliefs.js";
import { socket } from "./socket.js";
import { distance } from "./utils.js";

const __dir = dirname( fileURLToPath( import.meta.url ) );
const SHARED_CONFIG_PATH = join( __dir, '..', 'shared-config.json' );
const SLAVE_COMMAND_PATH = join( __dir, '..', 'slave-command.json' );
const SLAVE_STATUS_PATH = join( __dir, '..', 'slave-status.json' );

let selfAgentRef = null;
export function setSelfAgent ( agent ) { selfAgentRef = agent; }

let handoffConfig = null;

function findHandoffCorridor ( myPos, slavePos ) {
    const DIRS = [
        { dx: 1, dy: 0, name: 'right' }, { dx: -1, dy: 0, name: 'left' },
        { dx: 0, dy: 1, name: 'up' },   { dx: 0, dy: -1, name: 'down' },
    ];
    let best = null, bestScore = Infinity;
    for ( const [ , tile ] of mapBeliefs ) {
        if ( tile.type === '0' ) continue;
        for ( const dir of DIRS ) {
            const T_slave   = { x: tile.x + dir.dx, y: tile.y + dir.dy };
            const T_retreat = { x: tile.x - dir.dx, y: tile.y - dir.dy };
            const st = mapBeliefs.get( `${T_slave.x}_${T_slave.y}` );
            const rt = mapBeliefs.get( `${T_retreat.x}_${T_retreat.y}` );
            if ( !st || st.type === '0' ) continue;
            if ( !rt || rt.type === '0' ) continue;
            const score = distance( myPos, tile ) + distance( slavePos, T_slave );
            if ( score < bestScore ) { bestScore = score; best = { T_llm: tile, T_slave, T_retreat, dir: dir.name }; }
        }
    }
    return best;
}

function writeSharedConfig () {
    const snapshot = {
        forbiddenTiles:      Array.from( dynamicRules.forbiddenTiles ),
        deliveryMultipliers: Object.fromEntries( dynamicRules.deliveryMultipliers ),
        stackSizeRule:       dynamicRules.stackSizeRule,
        parcelMaxReward:     isFinite( dynamicRules.parcelMaxReward ) ? dynamicRules.parcelMaxReward : null,
        bonusTiles:          Object.fromEntries( dynamicRules.bonusTiles ),
        edgeRules:           Object.fromEntries( dynamicRules.edgeRules ),
    };
    writeFileSync( SHARED_CONFIG_PATH, JSON.stringify( snapshot, null, 2 ) );
    console.log( '[shared-config] Written to disk.' );
}

// ==========================================
// 1. LiteLLM Configuration
// ==========================================

const baseURL = process.env.LITELLM_BASE_URL || "https://llm.bears.disi.unitn.it/v1";
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || "llama-3.3-70b-lmstudio";

if (!apiKey) {
  console.error("Error: missing LITELLM_API_KEY in .env file");
  process.exit(1);
}

// ==========================================
// 2. OpenAI-compatible client
// ==========================================

const client = new OpenAI({
  baseURL,
  apiKey,
});

// ==========================================
// 3. Tools
// ==========================================

function set_forbidden_tile(input) {
    const [x, y] = input.split(',').map(s => Number(s.trim()));
    dynamicRules.forbiddenTiles.add(`${x}_${y}`);
    writeSharedConfig();
    return `Tile (${x},${y}) is now forbidden.`;
}

function set_delivery_multiplier(input) {
    const [x, y, multiplier] = input.split(',').map(s => Number(s.trim()));
    dynamicRules.deliveryMultipliers.set(`${x}_${y}`, multiplier);
    if (multiplier <= 0) {
        dynamicRules.forbiddenTiles.add(`${x}_${y}`);
    }
    writeSharedConfig();
    return `Delivery multiplier at (${x},${y}) set to ${multiplier}x.`;
}

function set_stack_size(input) {
    const [size, multiplier] = input.split(',').map(s => Number(s.trim()));
    dynamicRules.stackSizeRule = { size, multiplier };
    writeSharedConfig();
    return `Stack rule applied: Stacks of exactly ${size} get a ${multiplier}x multiplier.`;
}

function set_parcel_filter(input) {
    const maxReward = Number(input.trim());
    dynamicRules.parcelMaxReward = maxReward;
    writeSharedConfig();
    return `Agent will now pick up parcels, but wait to deliver them until their reward decays to ${maxReward} or below.`;
}

function set_location_rule(input) {
    // Expected variations: 
    // "4, 8, 10, true" or "4, 8, -20, false"
    // "leftmost, 5, true" or "top, -10, false"
    const parts = input.split(',');
    let target = parts[0].trim().toLowerCase();
    
    // 1. Handle Keyword Maps (leftmost, rightmost, top, bottom)
    if (['leftmost', 'rightmost', 'top', 'bottom'].includes(target)) {
        const pts = Number(parts[1].trim());
        const mustDrop = parts[2] ? parts[2].trim().toLowerCase() === 'true' : false;
        const edgeMap = /** @type {Record<string, string>} */ ({ leftmost: 'left', rightmost: 'right', top: 'top', bottom: 'bottom' });
        const edge = edgeMap[target];
        dynamicRules.edgeRules.set(edge, { pts, mustDrop });
        writeSharedConfig();
        return `Edge rule recorded: ${target} edge assigned ${pts}pts. Must drop package: ${mustDrop}.`;
    }

    // 2. Handle Coordinate Calculations (x, y)
    else {
        const x = Number(parts[0].trim());
        const y = Number(parts[1].trim());
        const pts = Number(parts[2].trim());
        const mustDrop = parts[3] ? parts[3].trim().toLowerCase() === 'true' : false;
        const key = `${x}_${y}`;

        if (pts < 0) {
            dynamicRules.forbiddenTiles.add(key);
            dynamicRules.bonusTiles.delete(key);
            writeSharedConfig();
            return `Tile (${x},${y}) is now blacklisted due to negative feedback (${pts}pts).`;
        } else {
            if (dynamicRules.forbiddenTiles.has(key)) dynamicRules.forbiddenTiles.delete(key);
            dynamicRules.bonusTiles.set(key, { pts, mustDrop });
            writeSharedConfig();
            return `Reward profile established at (${x},${y}) for ${pts}pts. Must drop package: ${mustDrop}.`;
        }
    }
}

async function set_neighborhood_mission(input) {
    // Input: "cx, cy, radius, pts" — e.g. "5, 5, 3, 500"
    const parts = input.split(',').map(s => Number(s.trim()));
    const [ cx, cy, radius, pts = 500 ] = parts;

    if ( isNaN(cx) || isNaN(cy) || isNaN(radius) ) {
        return `Error: invalid input. Expected "cx, cy, radius" or "cx, cy, radius, pts".`;
    }

    // Collect walkable tiles within Manhattan distance radius from center
    const tiles = [];
    for ( let dx = -radius; dx <= radius; dx++ ) {
        for ( let dy = -radius; dy <= radius; dy++ ) {
            if ( Math.abs(dx) + Math.abs(dy) > radius ) continue;
            const nx = Math.round(cx) + dx;
            const ny = Math.round(cy) + dy;
            const tile = mapBeliefs.get( `${nx}_${ny}` );
            if ( tile && tile.type !== '0' ) tiles.push( { x: nx, y: ny } );
        }
    }

    if ( tiles.length === 0 ) {
        return `No walkable tiles found in neighborhood around (${cx},${cy}) with radius ${radius}. Has the map been loaded yet?`;
    }

    const effectivePts = isNaN(pts) ? 500 : pts;

    // Reset completion flag before sending so a stale true from a previous call doesn't fire immediately
    try {
        const prev = existsSync( SLAVE_STATUS_PATH ) ? JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) ) : {};
        writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { ...prev, neighborhoodDone: false }, null, 2 ) );
    } catch ( _ ) {}

    // Send command to slave agent via file
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'GO_TO_NEIGHBORHOOD', tiles, pts: effectivePts }, null, 2 ) );

    // Push to self (LLM) agent
    if ( selfAgentRef ) selfAgentRef.pushUrgent( [ 'go_to_neighborhood', tiles, effectivePts ] );

    console.log( `[neighborhood] Mission started: ${tiles.length} tiles around (${cx},${cy}), pts=${effectivePts}` );

    // Block until GoToNeighborhood plan completes on both sides (writes neighborhoodDone: true after RESUME)
    const deadline = Date.now() + 90000;
    while ( Date.now() < deadline ) {
        try {
            if ( existsSync( SLAVE_STATUS_PATH ) ) {
                const s = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
                if ( s.neighborhoodDone === true )
                    return `Neighborhood mission complete: both agents reached area around (${cx},${cy}).`;
            }
        } catch ( _ ) {}
        await new Promise( r => setTimeout( r, 200 ) );
    }
    return `Timeout: neighborhood mission around (${cx},${cy}) did not complete within 90s.`;
}

async function move_to_matching_tile(input) {
    // Input: "condition" or "condition, pts" — pts is optional, defaults to 500
    // Split on last comma to avoid breaking conditions like "x == 0 || y == 0"
    const lastComma = input.lastIndexOf(',');
    let condition, pts;
    if (lastComma !== -1) {
        const afterComma = input.slice(lastComma + 1).trim();
        const parsedPts = Number(afterComma);
        if (!isNaN(parsedPts)) {
            condition = input.slice(0, lastComma).trim();
            pts = parsedPts;
        } else {
            condition = input.trim();
            pts = 500;
        }
    } else {
        condition = input.trim();
        pts = 500;
    }

    // Validate condition before sending anywhere
    let fn;
    try { fn = new Function('x', 'y', `return !!(${condition})`); }
    catch (e) { return `Error: invalid condition "${condition}": ${e.message}`; }

    try {
        const prev = existsSync( SLAVE_STATUS_PATH ) ? JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) ) : {};
        writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { ...prev, conditionMet: false }, null, 2 ) );
    } catch ( _ ) {}
    writeFileSync(SLAVE_COMMAND_PATH, JSON.stringify({ cmd: 'GO_TO_MATCHING_TILE', condition, pts }));
    if (selfAgentRef) selfAgentRef.pushUrgent(['go_to_matching_tile', condition, pts]);

    // Block until both agents have arrived
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const selfMet = fn(Math.round(me.x), Math.round(me.y));
        let slaveMet = false, slavePos = null;
        try {
            if (existsSync(SLAVE_STATUS_PATH)) {
                const s = JSON.parse(readFileSync(SLAVE_STATUS_PATH, 'utf8'));
                if (s.conditionMet === true && s.condition === condition) {
                    slaveMet = true;
                    slavePos = { x: s.x, y: s.y };
                }
            }
        } catch (_) {}
        if (selfMet && slaveMet)
            return `Both agents at "${condition}". Self (${Math.round(me.x)},${Math.round(me.y)}), slave (${slavePos.x},${slavePos.y}).`;
        await new Promise(r => setTimeout(r, 200));
    }
    return `Timeout: agents did not reach "${condition}" within 30s.`;
}

// async function move_to_edge ( input ) {
//     const pts = Number( input.trim() ) || 500;

//     // Reset arrival flag before issuing the command
//     try {
//         const prev = existsSync( SLAVE_STATUS_PATH ) ? JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) ) : {};
//         writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { ...prev, edgeArrived: false }, null, 2 ) );
//     } catch ( _ ) {}

//     writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'MOVE_TO_EDGE', pts } ) );
//     if ( selfAgentRef ) selfAgentRef.pushUrgent( [ 'go_to_edge', pts ] );
//     console.log( `[move_to_edge] Both agents commanded to map border (pts=${pts})` );

//     // Block until both agents have reached a border tile
//     const { x: maxX, y: maxY, minX, minY } = mapWidthxHeight;
//     const deadline = Date.now() + 30000;
//     while ( Date.now() < deadline ) {
//         const x = Math.round( me.x ), y = Math.round( me.y );
//         const selfAtEdge = x === minX || x === maxX || y === minY || y === maxY;
//         let slaveAtEdge = false;
//         try {
//             if ( existsSync( SLAVE_STATUS_PATH ) ) {
//                 const s = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
//                 slaveAtEdge = s.edgeArrived === true;
//             }
//         } catch ( _ ) {}
//         if ( selfAtEdge && slaveAtEdge )
//             return `Both agents at map border. Self (${x},${y}).`;
//         await new Promise( r => setTimeout( r, 200 ) );
//     }
//     return `Timeout: agents did not reach map border within 60s.`;
// }

async function wait_both_at_condition(input) {
    const condition = input.trim();
    let fn;
    try { fn = new Function('x', 'y', `return !!(${condition})`); }
    catch (e) { return `Error: invalid condition "${condition}": ${e.message}`; }

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const selfMet = fn(Math.round(me.x), Math.round(me.y));

        let slaveMet = false, slavePos = null;
        try {
            if (existsSync(SLAVE_STATUS_PATH)) {
                const s = JSON.parse(readFileSync(SLAVE_STATUS_PATH, 'utf8'));
                if (s.conditionMet === true && s.condition === condition) {
                    slaveMet = true;
                    slavePos = { x: s.x, y: s.y };
                }
            }
        } catch (_) {}

        if (selfMet && slaveMet)
            return `Both agents satisfy "${condition}". Self (${Math.round(me.x)},${Math.round(me.y)}), slave (${slavePos.x},${slavePos.y}).`;

        await new Promise(r => setTimeout(r, 200));
    }
    return `Timeout: not both agents satisfied "${condition}" within 30s.`;
}

function freeze_agents() {
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'FREEZE' } ) );
    if ( selfAgentRef ) selfAgentRef.freeze();
    console.log( '[freeze] Both agents frozen.' );
    return 'Both agents are now frozen and will stop moving.';
}

function unfreeze_agents() {
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'UNFREEZE' } ) );
    if ( selfAgentRef ) {
        const q = selfAgentRef.intention_queue;
        if ( q.length > 0 && [ 'go_to_matching_tile', 'go_to_neighborhood' ].includes( q[0].predicate[0] ) ) {
            q[0].stop();
        }
        selfAgentRef.unfreeze();
    }
    console.log( '[unfreeze] Both agents unfrozen.' );
    return 'Both agents are now unfrozen and will resume normal operation.';
}

function setup_handoff_pipeline ( input ) {
    const parts = input.split( ',' ).map( s => Number( s.trim() ) );
    const [ bonus_pts, threshold = 3 ] = parts;
    if ( isNaN( bonus_pts ) ) return 'Error: invalid bonus_pts.';
    handoffConfig = { bonus_pts, threshold };
    console.log( `[handoff] Pipeline configured: bonus=${bonus_pts}, threshold=${threshold}` );
    return `Handoff pipeline active. Will trigger when combined carried parcels ≥ ${threshold}. Bonus: ${bonus_pts} pts per handoff parcel.`;
}

async function calculate(expression) {
  console.log("---- CALCULATE ----");

  try {
    // Expose bare Math names (round, floor, sqrt, …) so the model can skip "Math."
    const preamble = 'const {abs,ceil,floor,round,sqrt,min,max,pow,log,PI}=Math;';
    const result = String(eval(preamble + expression));
    await socket.emitAsk( currentSenderId, result );
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'SAY', toId: currentSenderId, message: result } ) );
    return result;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

async function get_current_time(location) {
  console.log("---- GET CURRENT TIME ----");

  try {
    const normalized = location.trim().toLowerCase();

    const supportedLocations = {
      rome: { city: "Rome", timeZone: "Europe/Rome" },
      roma: { city: "Rome", timeZone: "Europe/Rome" },
    };

    const config = supportedLocations[normalized];

    if (!config) {
      return "Error: Current time is only supported for Rome/Roma in this demo.";
    }

    const now = new Date();

    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));

    const formattedDate = `${map.year}-${map.month}-${map.day}`;
    const formattedTime = `${map.hour}:${map.minute}:${map.second}`;

    const timeMessage = `The current local time in ${config.city} is ${formattedDate} ${formattedTime} (${config.timeZone}).`;
    await socket.emitAsk( currentSenderId, timeMessage );
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'SAY', toId: currentSenderId, message: timeMessage } ) );
    return timeMessage;
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

let genericAnwer = false;

function genericResponse() {
  genericAnwer = true;
  return "The requested tool is not available. Answering with a generic response instead.";
}

const TOOLS = {
    calculate,
    get_current_time,
    set_forbidden_tile,
    set_delivery_multiplier,
    set_stack_size,
    set_parcel_filter,
    set_location_rule,
    set_neighborhood_mission,
    move_to_matching_tile,
    // move_to_edge,
    wait_both_at_condition,
    freeze_agents,
    unfreeze_agents,
    setup_handoff_pipeline,
    genericResponse
};
// ==========================================
// 4. Reusable LLM call
// ==========================================

async function callModel(messages, { temperature = 0 } = {}) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature,
  });

  return response.choices?.[0]?.message?.content ?? "";
}

// ==========================================
// 5. Output parsing
// ==========================================

function extractAction(text) {
  const actionMatch = text.match(/^Action:\s*(.+)$/im);
  // Allow empty Action Input (for no-arg tools like genericResponse)
  const actionInputMatch = text.match(/^Action Input:\s*(.*)$/im);

  if (!actionMatch || !actionInputMatch) {
    return null;
  }

  const actionInput = actionInputMatch[1].trim();
  // Treat "none" as empty (model sometimes writes "Action Input: none")
  return {
    action: actionMatch[1].trim(),
    actionInput: actionInput === 'none' ? '' : actionInput,
  };
}

function extractStepResult(text) {
  const match = text.match(/^Step Result:\s*([\s\S]*)$/im);

  if (!match) {
    return null;
  }

  return match[1].trim();
}

function countActions(text) {
  const matches = text.match(/^Action:\s*.+$/gim);
  return matches ? matches.length : 0;
}

function hasBothActionAndStepResult(text) {
  const actionMatch = text.match(/^Action:\s*(.+)$/im);
  const stepResultMatch = text.match(/^Step Result:\s*[\s\S]*$/im);

  if (!actionMatch || !stepResultMatch) {
    return false;
  }

  const action = actionMatch[1].trim().toLowerCase();

  return action !== "none";
}

function safeJsonParse(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ==========================================
// 6. Prompts
// ==========================================

const PLANNER_PROMPT = `
You are the strategic planning module of an AI agent connected to a game environment, called DeliverooJS.
The agent moves and operates autonomously. Your job is NOT to move the agent, but to translate user messages about game rules, bonuses, and penalties into configuration steps.

Coordinate system: X increases rightward, Y increases downward (screen coordinates).
  leftmost  = X = minX  |  rightmost = X = maxX
  topmost   = Y = minY  |  bottommost = Y = maxY
The actual map bounds are provided in the state note below.

Available tools:
- calculate(expression): evaluates a mathematical expression
- get_current_time(location): returns the current local time for Rome/Roma
- set_forbidden_tile(coordinates): prevents the agent from entering a tile. Input format: "x, y" (e.g., "4, 7"). Called for example if the user mentions a penalty (negative bonus) for moving to a tile.
- set_delivery_multiplier(params): multiplies the reward for delivering at a tile. Usually the request contains keywords such as: "from now on" or "every time". Input format: "x, y, multiplier" (e.g., "4, 7, 5")
- set_stack_size(params): requires the agent to carry exactly 'size' parcels to get a 'multiplier'. Input format: "size, multiplier" (e.g., "3, 2")
- set_parcel_filter(maxReward): instructs the agent to wait to deliver and/or pick up parcels until their reward decays to maxReward or below. Input format: "maxReward" (e.g., "10")
- set_location_rule(params): Configures point allocations or route bans based on spatial regions or tiles. The user can request the agent to reach a specific location (specific coordinate or border) and wether to drop a package on it. If the bonus on a specific tile is negative, call 'set_forbidden_tile' to blacklist it. Input format: "target, pts, mustDrop" where target is a coordinate pair 'x, y' or edge terms ('leftmost', 'rightmost', 'top', 'bottom'), pts is an integer value, and mustDrop is a boolean (true if the agent must drop a package, false if it just needs to visit. If not specified, it defaults to false). (e.g., "0, 0, 10, true" or "leftmost, -10, false").
- set_neighborhood_mission(params): Sends BOTH agents to a neighborhood (area around a map position). Both agents independently navigate to the nearest free tile within the area and wait for each other before resuming. Input format: "cx, cy, radius, pts" where cx/cy is the center coordinate, radius is the Manhattan distance radius, and pts is the bonus points (default 500). (e.g., "5, 5, 3, 500").
- move_to_matching_tile(params): Sends BOTH agents to the nearest tile satisfying a JS condition, then blocks until both arrive (up to 30s). Call this tool only if the user explicitly requests the agents to stop. If the request is to reach a specific tile, don't use this tool, use: 'set_location_rule'. Input format: "condition, pts" where condition is a JS boolean expression on x and y, and pts is the bonus/penalty value (default 500, negative = command ignored). (e.g., "y % 2 == 1, 700").
- freeze_agents(): Immediately stops BOTH agents. They will not move or pick up parcels until unfrozen. No input required.
- unfreeze_agents(): Resumes normal operation for BOTH agents after a freeze. No input required.
- setup_handoff_pipeline(params): Sets up automatic cross-agent parcel handoff. Monitors both agents; when combined carried parcels reach the threshold, triggers a coordinated exchange so the LLM agent delivers all parcels and earns the cross-agent bonus. Input format: "bonus_pts, threshold" (e.g., "200, 3"). Default threshold=3.
- genericResponse(): if the user request cannot be fulfilled with the available tools, call this to return a generic response to the user without making any configuration changes. Let the answer be very concise and straight to the point.

Rules:
- Return ONLY valid JSON.
- Do not use markdown.
- Do not explain.
- Keep the plan short: 1 to 5 steps.
- Each step must be concrete and executable.
- If the user uses math to define coordinates (e.g., "x=4*2"), include a step that uses calculate first.
- If the user mentions a penalty for moving to a tile, use set_forbidden_tile.
- If the user mentions a bonus for cross-agent parcel delivery (one agent picks up, another delivers), call setup_handoff_pipeline.
- move_to_matching_tile already block until both agents arrive. NEVER add any wait or hold step after them in the same plan.
- If the current agent state is frozen and the user requests any movement or action that requires the agents to move, ALWAYS begin the plan with unfreeze_agents() as step 1.
- If the user sends only a generic movement word with no destination ("move", "go", "start", "resume", "continue") and does not specify any target, condition, or location, call ONLY unfreeze_agents() and nothing else. Do NOT invent a destination.
- Do NOT try to move the agent or check its position.
- If the user asks for a tool that is not available, do not call any tool and return a step that says "The requested tool is not available."

Return exactly this JSON shape:
{
  "steps": [
    "step 1",
    "step 2"
  ]
}
`.trim();

const EXECUTOR_PROMPT = `
You are the rule-execution module inside an AI agent connected to a DeliverooJS environment.
You execute exactly ONE step at a time to update the agent's internal rules.

Available tools:
- calculate(expression)
- get_current_time(location)
- set_forbidden_tile(coordinates) -> format: "x, y"
- set_delivery_multiplier(params) -> format: "x, y, multiplier"
- set_stack_size(params) -> format: "size, multiplier"
- set_parcel_filter(maxReward) -> format: "maxReward"
- set_location_rule(params) -> format: "target, pts, mustDrop" where target is a coordinate pair 'x, y' or edge terms ('leftmost', 'rightmost', 'top', 'bottom'), pts is an integer value, and mustDrop is a boolean (true to drop, false to visit).
- set_neighborhood_mission(params) -> format: "cx, cy, radius, pts" — sends both agents to the area around (cx,cy) within Manhattan radius. Both wait for each other then resume.
- move_to_matching_tile(params) -> format: "condition, pts" — sends both agents to nearest matching tile and blocks until both arrive (e.g., "y % 2 == 1, 700"). pts negative = command ignored.
- wait_both_at_condition(condition) -> format: condition string — blocks until both agents already in motion have reached a matching tile. Times out after 30s.
- freeze_agents() -> no input — immediately stops both agents. They will not move until unfrozen.
- unfreeze_agents() -> no input — resumes both agents after a freeze.
- setup_handoff_pipeline(params) -> format: "bonus_pts, threshold" — sets up automatic handoff monitoring. Triggers exchange when combined carried parcels ≥ threshold. (e.g., "200, 3")
- genericResponse() -> no input, returns a generic fallback response to the user without making any configuration changes. Concise and straight to the point.

You receive:
- the original user request
- the full plan
- completed step results so far
- the current step to execute

STRICT OUTPUT FORMAT — choose exactly one format.

FORMAT 1 — use one tool:

Thought: <brief reasoning>
Action: <tool name>
Action Input: <tool input>

FORMAT 2 — step complete:

Thought: I completed this step.
Step Result: <result for this step>

Rules:
- Execute only the current step.
- Output exactly one action at a time.
- Never write Action: None.
- Do not invent tool results.
- For tools requiring multiple arguments, you MUST separate them with commas in the Action Input (e.g., Action Input: 4, 7, 10).
- If the current step requires math, call calculate.
- Do NOT attempt to use 'move' or 'get_my_position'. They no longer exist.
- Once a tool returns a success observation, return the Step Result in the next turn.
`.trim();

const FINAL_ANSWER_PROMPT = `
You are the final response module of an AI agent.

You receive:
- the original user request
- the plan that was executed
- the result of each step

Write a clear, concise final answer for the user.
If any step failed or could not be verified, say so explicitly.
`.trim();

// ==========================================
// 7. Conversation memory
// ==========================================

const MAX_HISTORY = 20;

// ID of the agent whose message is currently being processed.
// Set at the start of each onMsg handler and used by tools that reply.
let currentSenderId = ADMIN_ID;

// Global memory stores only the visible conversation.
// It does not store internal actions, observations, or plans.
const messages = [
  {
    role: "system",
    content: "You are a concise assistant.",
  },
];

// ==========================================
// 8. Planner
// ==========================================

async function createPlan(userInput) {
  const frozenState = selfAgentRef?.frozen ? 'frozen (both agents are currently stopped)' : 'moving (both agents are currently active)';
  const { x: maxX, y: maxY, minX, minY } = mapWidthxHeight;
  const boundsNote = maxX > 0
      ? ` Map bounds: X(${minX}..${maxX}), Y(${minY}..${maxY}). Edges: leftmost x==${minX}, rightmost x==${maxX}, topmost y==${minY}, bottommost y==${maxY}.`
      : ' Map not yet loaded.';
  const stateNote = `\n\nCurrent agent state: ${frozenState}.${boundsNote}`;

  // Fix 1: inject conversation history so the planner has context from prior turns
  const plannerMessages = [
    {
      role: "system",
      content: PLANNER_PROMPT + stateNote,
    },
    ...messages.slice(1),   // history: alternating user/assistant turns (skip system placeholder)
    {
      role: "user",
      content: userInput,
    },
  ];

  const rawPlan = await callModel(plannerMessages, { temperature: 0 });

  console.log("=== PLAN RAW OUTPUT ===");
  console.log(rawPlan);
  console.log();

  const parsedPlan = safeJsonParse(rawPlan);

  if (
    !parsedPlan ||
    !Array.isArray(parsedPlan.steps) ||
    parsedPlan.steps.length === 0
  ) {
    console.log("Warning: planner returned invalid JSON. Using fallback plan.\n");

    return {
      steps: [`Answer the user's request: ${userInput}`],
    };
  }

  return parsedPlan;
}

// ==========================================
// 9. Step executor
// ==========================================

async function executeStep(step, context, maxStepIterations = 4) {
  const toolsCalled = [];

  const stepMessages = [
    {
      role: "system",
      content: EXECUTOR_PROMPT,
    },
    {
      role: "user",
      content:
        `Original user request:\n${context.userInput}\n\n` +
        `Full plan:\n${context.plan.steps
          .map((s, index) => `${index + 1}. ${s}`)
          .join("\n")}\n\n` +
        `Completed step results so far:\n${
          context.completedResults.length > 0
            ? context.completedResults
                .map((result, index) => `${index + 1}. ${result}`)
                .join("\n")
            : "None"
        }\n\n` +
        `Current step to execute:\n${step}`,
    },
  ];

  console.log("=== EXECUTING STEP ===");
  console.log(step);
  console.log();

  for (let i = 0; i < maxStepIterations; i++) {
    console.log(`--- Step iteration ${i + 1} ---`);

    const assistantMessage = await callModel(stepMessages, { temperature: 0 });

    console.log(`Assistant output:\n${assistantMessage}\n`);

    stepMessages.push({
      role: "assistant",
      content: assistantMessage,
    });

    const actionCount = countActions(assistantMessage);
    const mixedOutput = hasBothActionAndStepResult(assistantMessage);

    if (actionCount > 1) {
      console.log(
        `[Warning: model output contained ${actionCount} actions. ` +
          `The runtime will execute only the first one.]\n`
      );
    }

    if (mixedOutput) {
      console.log(
        "[Warning: model output contained both Action and Step Result. " +
          "The runtime will execute the Action and ignore the premature Step Result.]\n"
      );
    }

    // Defensive rule:
    // If an Action is present, execute it before accepting any Step Result.
    const parsedAction = extractAction(assistantMessage);

    if (parsedAction) {
      const { action, actionInput } = parsedAction;

      let observation;

      if (TOOLS[action]) {
        console.log(`[System executing tool: ${action}("${actionInput}")]`);
        toolsCalled.push(action);
        observation = await TOOLS[action](actionInput);
      } else {
        observation =
          `Error: unknown tool '${action}'. ` +
          `Available tools: ${Object.keys(TOOLS).join(", ")}`;
      }

      console.log(`[Observation: ${observation}]\n`);

      stepMessages.push({
        role: "user",
        content:
          `Observation: ${observation}\n\n` +
          `Now complete the current step. ` +
          `Return a Step Result. Do not execute future steps. ` +
          `Remember: output only one Action or one Step Result.`,
      });

      continue;
    }

    const stepResult = extractStepResult(assistantMessage);

    if (stepResult) {
      return {
        success: true,
        result: stepResult,
        toolsCalled,
      };
    }

    const observation =
      "Error: invalid format. You must output either one Action or one Step Result.";

    console.log(`[Observation: ${observation}]\n`);

    stepMessages.push({
      role: "user",
      content: `Observation: ${observation}`,
    });
  }

  return {
    success: false,
    result: `Step could not be completed: ${step}`,
    toolsCalled,
  };
}

// ==========================================
// 10. Final answer builder
// ==========================================

async function buildFinalAnswer(userInput, plan, completedResults) {
  const finalMessages = [
    {
      role: "system",
      content: FINAL_ANSWER_PROMPT,
    },
    {
      role: "user",
      content:
        `Original user request:\n${userInput}\n\n` +
        `Executed plan:\n${plan.steps
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")}\n\n` +
        `Step results:\n${completedResults
          .map((result, index) => `${index + 1}. ${result}`)
          .join("\n")}`,
    },
  ];

  return await callModel(finalMessages, { temperature: 0.1 });
}

// ==========================================
// 11. Agent turn
// ==========================================

async function runAgentTurn(userInput) {
  // 1. Create a plan (Fix 1+3: inject history and live agent state)
  const plan = await createPlan(userInput);

  console.log("=== PLAN ===");
  plan.steps.forEach((step, index) => {
    console.log(`${index + 1}. ${step}`);
  });
  console.log();

  // 2. Execute each planned step explicitly
  const completedResults = [];
  const allToolsCalled = [];

  for (const step of plan.steps) {
    const execution = await executeStep(step, {
      userInput,
      plan,
      completedResults,
    });

    completedResults.push(execution.result);
    if (execution.toolsCalled) allToolsCalled.push(...execution.toolsCalled);
  }

  console.log("=== STEP RESULTS ===");
  completedResults.forEach((result, index) => {
    console.log(`${index + 1}. ${result}`);
  });
  console.log();

  // 3. Build final answer from all step results
  const finalAnswer = await buildFinalAnswer(userInput, plan, completedResults);

  console.log(`Assistant: ${finalAnswer}\n`);

  if (genericAnwer) {
    console.log("[Note: the assistant returned a generic response, likely because the user's request could not be fulfilled with the available tools.]\n");
    genericAnwer = false;
    await socket.emitAsk( currentSenderId, finalAnswer );
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'SAY', toId: currentSenderId, message: finalAnswer } ) );
  }
  

  // 4. Store conversation with tool log prepended (Fix 2)
  messages.push({
    role: "user",
    content: userInput,
  });

  const uniqueTools = [ ...new Set( allToolsCalled ) ];
  const toolPrefix = uniqueTools.length > 0
      ? `[Actions taken: ${uniqueTools.join(', ')}]\n\n`
      : '';
  messages.push({
    role: "assistant",
    content: toolPrefix + finalAnswer,
  });

  // Sliding Window Memory Pruning
  if (messages.length > MAX_HISTORY + 1) {
    const excess = messages.length - (MAX_HISTORY + 1);
    // splice(start_index, delete_count)
    // We start at index 1 to protect the system prompt!
    messages.splice(1, excess);
    console.log(`[Memory] Auto-pruned the ${excess} oldest messages to prevent context overflow.`);
  }
}

// ==========================================
// 12. DeliverooJS Chat Listener
// ==========================================

console.log("Planner + Executor Agent started.");
console.log("Listening to DeliverooJS chat...");
console.log("Only accepting commands from player id: 'admin'.\n");

// Reset all shared files so both agents start from a clean state
writeSharedConfig();
writeFileSync( SLAVE_STATUS_PATH,  JSON.stringify( { arrived: false, conditionMet: false, handoffPhase: null }, null, 2 ) );
writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( {} ) );

// Serialize all runAgentTurn calls — if a second message arrives while a plan is
// executing, it is queued and processed after the current plan finishes or times out.
let commandQueue = Promise.resolve();

socket.onMsg(async (id, name, msg) => {
  // Security check: Ignore all messages unless the ID is exactly 'admin'

  // if (id != ADMIN_ID && name.toLowerCase() != ADMIN_NAME) {
  //   console.log(`[Blocked] Ignored message from ${name} (${id}): ${msg}`);
  //   return;
  // }

  console.log(`=== COMMAND FROM ${name} (${id}) ===`);
  console.log(`Message: ${msg}\n`);

  const command = msg.trim().toLowerCase();

  if (command === "/memory") {
    console.dir(messages, { depth: null });
    console.log();
    return;
  }

  if (command === "/reset") {
    messages.splice(1);
    console.log("Conversation memory reset.\n");
    return;
  }

  if (msg.trim() === "") {
    return;
  }

  // Snapshot sender ID and message now; they must be captured per-command because the
  // queue runs commands asynchronously after the handler returns.
  const senderId = id;
  const msgSnapshot = msg;

  commandQueue = commandQueue.then( async () => {
    currentSenderId = senderId;
    await runAgentTurn( msgSnapshot );
    console.log(`Visible memory contains ${messages.length} messages.\n`);
  } ).catch( () => {} );
});

// ─── Handoff pipeline monitor ─────────────────────────────────────────────────
const HANDOFF_COOLDOWN_MS = 10000;

socket.onSensing( () => {
    if ( !handoffConfig || handoffState.inProgress || !selfAgentRef ) return;
    if ( Date.now() - handoffState.lastCompletedAt < HANDOFF_COOLDOWN_MS ) return;
    // Do not trigger handoff while a coordination hold is active — it would interrupt the
    // hold plan, causing the coordination tool's poll loop to time out.
    const q = selfAgentRef.intention_queue;
    if ( q.length > 0 && [ 'go_to_matching_tile', 'go_to_neighborhood' ].includes( q[0].predicate[0] ) ) return;
    const myCount = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id ).length;
    try {
        if ( !existsSync( SLAVE_STATUS_PATH ) ) return;
        const status = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
        const slaveCount = status.carriedCount ?? 0;
        if ( myCount + slaveCount < handoffConfig.threshold ) return;
        if ( status.x == null || status.y == null ) return;
        const corridor = findHandoffCorridor( me, { x: status.x, y: status.y } );
        if ( !corridor ) { console.log( '[handoff] No 3-tile corridor found.' ); return; }
        handoffState.inProgress = true;
        console.log( `[handoff] Triggering. Corridor: T_llm(${corridor.T_llm.x},${corridor.T_llm.y}) T_slave(${corridor.T_slave.x},${corridor.T_slave.y}) dir=${corridor.dir}` );
        selfAgentRef.pushUrgent( [
            'handoff_llm',
            corridor.T_llm.x, corridor.T_llm.y,
            corridor.T_retreat.x, corridor.T_retreat.y,
            corridor.T_slave.x, corridor.T_slave.y,
            corridor.dir,
        ] );
    } catch ( e ) { console.error( '[handoff] Monitor error:', e.message ); }
} );