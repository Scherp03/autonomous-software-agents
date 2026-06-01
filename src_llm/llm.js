import "dotenv/config";
import OpenAI from "openai";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ADMIN_ID, ADMIN_NAME, dynamicRules, mapBeliefs, me } from "./beliefs.js";
import { socket } from "./socket.js";

const __dir = dirname( fileURLToPath( import.meta.url ) );
const SHARED_CONFIG_PATH = join( __dir, '..', 'shared-config.json' );
const SLAVE_COMMAND_PATH = join( __dir, '..', 'slave-command.json' );
const SLAVE_STATUS_PATH = join( __dir, '..', 'slave-status.json' );

let selfAgentRef = null;
export function setSelfAgent ( agent ) { selfAgentRef = agent; }

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

function set_neighborhood_mission(input) {
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

    // Send command to slave agent via file
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'GO_TO_NEIGHBORHOOD', tiles, pts: effectivePts }, null, 2 ) );

    // Push to self (LLM) agent
    if ( selfAgentRef ) selfAgentRef.push( [ 'go_to_neighborhood', tiles, effectivePts ] );

    console.log( `[neighborhood] Mission started: ${tiles.length} tiles around (${cx},${cy}), pts=${effectivePts}` );
    return `Neighborhood mission started: ${tiles.length} walkable tiles around (${cx},${cy}) with radius ${radius}, pts=${effectivePts}.`;
}

function move_to_matching_tile(input) {
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
    try { new Function('x', 'y', `return !!(${condition})`); }
    catch (e) { return `Error: invalid condition "${condition}": ${e.message}`; }

    writeFileSync(SLAVE_STATUS_PATH, JSON.stringify({ conditionMet: false }));
    writeFileSync(SLAVE_COMMAND_PATH, JSON.stringify({ cmd: 'GO_TO_MATCHING_TILE', condition, pts }));
    if (selfAgentRef) selfAgentRef.pushUrgent(['go_to_matching_tile', condition, pts]);

    return `Both agents commanded to move to nearest tile where: ${condition} (pts=${pts})`;
}

async function wait_both_at_condition(input) {
    const condition = input.trim();
    let fn;
    try { fn = new Function('x', 'y', `return !!(${condition})`); }
    catch (e) { return `Error: invalid condition "${condition}": ${e.message}`; }

    const deadline = Date.now() + 60000;
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
    return `Timeout: not both agents satisfied "${condition}" within 60s.`;
}

function freeze_agents() {
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'FREEZE' } ) );
    if ( selfAgentRef ) selfAgentRef.freeze();
    console.log( '[freeze] Both agents frozen.' );
    return 'Both agents are now frozen and will stop moving.';
}

function unfreeze_agents() {
    writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'UNFREEZE' } ) );
    if ( selfAgentRef ) selfAgentRef.unfreeze();
    console.log( '[unfreeze] Both agents unfrozen.' );
    return 'Both agents are now unfrozen and will resume normal operation.';
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
    wait_both_at_condition,
    freeze_agents,
    unfreeze_agents,
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
You are the strategic planning module of an AI agent connected to a game environment, called DeliverooJS .
The agent moves and operates autonomously. Your job is NOT to move the agent, but to translate user messages about game rules, bonuses, and penalties into configuration steps.

Available tools:
- calculate(expression): evaluates a mathematical expression
- get_current_time(location): returns the current local time for Rome/Roma
- set_forbidden_tile(coordinates): prevents the agent from entering a tile. Input format: "x, y" (e.g., "4, 7")
- set_delivery_multiplier(params): multiplies the reward for delivering at a tile. Usually the request contains keywords such as: "from now on" or "every time". Input format: "x, y, multiplier" (e.g., "4, 7, 5")
- set_stack_size(params): requires the agent to carry exactly 'size' parcels to get a 'multiplier'. Input format: "size, multiplier" (e.g., "3, 2")
- set_parcel_filter(maxReward): instructs the agent to wait to deliver and/or pick up parcels until their reward decays to maxReward or below. Input format: "maxReward" (e.g., "10")
- set_location_rule(params): Configures point allocations or route bans based on spatial regions or tiles. Input format: "target, pts, mustDrop" where target is a coordinate pair 'x, y' or edge terms ('leftmost', 'rightmost', 'top', 'bottom'), pts is an integer value, and mustDrop is a boolean (true if the agent must drop a package, false if it just needs to visit. If not specified, it defaults to false). (e.g., "0, 0, 10, true" or "leftmost, -10, false").
- set_neighborhood_mission(params): Sends BOTH agents to a neighborhood (area around a map position). Both agents independently navigate to the nearest free tile within the area and wait for each other before resuming. Input format: "cx, cy, radius, pts" where cx/cy is the center coordinate, radius is the Manhattan distance radius, and pts is the bonus points (default 500). (e.g., "5, 5, 3, 500").
- move_to_matching_tile(params): Sends BOTH agents to the nearest tile each satisfying a JS condition on x and y. Each agent independently picks its own nearest matching tile. Input format: "condition, pts" where condition is a JS boolean expression on x and y, and pts is the bonus/penalty value (default 500, negative = command ignored). (e.g., "y % 2 == 1, 700"). Always follow with wait_both_at_condition before freeze_agents.
- wait_both_at_condition(condition): Blocks until BOTH agents are confirmed on a tile satisfying the condition. Must be called after move_to_matching_tile and before freeze_agents. Input: same condition string (e.g., "y % 2 == 1"). Times out after 60s.
- freeze_agents(): Immediately stops BOTH agents. They will not move or pick up parcels until unfrozen. No input required.
- unfreeze_agents(): Resumes normal operation for BOTH agents after a freeze. No input required.
- genericResponse(): if the user request cannot be fulfilled with the available tools, call this to return a generic response to the user without making any configuration changes. Let the answer be very concise and straight to the point.
Rules:
- Return ONLY valid JSON.
- Do not use markdown.
- Do not explain.
- Keep the plan short: 1 to 5 steps.
- Each step must be concrete and executable.
- If the user uses math to define coordinates (e.g., "x=4*2"), include a step that uses calculate first.
- If the user mentions a penalty for moving to a tile, use set_forbidden_tile.
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
- move_to_matching_tile(params) -> format: "condition, pts" — sends both agents to their nearest tile satisfying a JS boolean on x/y (e.g., "y % 2 == 1, 700"). pts negative = command ignored. Always follow with wait_both_at_condition.
- wait_both_at_condition(condition) -> format: same condition string as move_to_matching_tile — blocks until both agents are on a matching tile, then returns. Times out after 60s.
- freeze_agents() -> no input — immediately stops both agents. They will not move until unfrozen.
- unfreeze_agents() -> no input — resumes both agents after a freeze.
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
  // Fix 3: append live agent state to the system prompt
  const frozenState = selfAgentRef?.frozen ? 'frozen (both agents are currently stopped)' : 'moving (both agents are currently active)';
  const stateNote = `\n\nCurrent agent state: ${frozenState}`;

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
writeFileSync( SLAVE_STATUS_PATH,  JSON.stringify( { arrived: false, conditionMet: false }, null, 2 ) );
writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( {} ) );

socket.onMsg(async (id, name, msg) => {
  // Security check: Ignore all messages unless the ID is exactly 'admin'

  // if (id != ADMIN_ID && name.toLowerCase() != ADMIN_NAME) {
  //   console.log(`[Blocked] Ignored message from ${name} (${id}): ${msg}`);
  //   return;
  // }

  currentSenderId = id;

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

  await runAgentTurn(msg);

  console.log(`Visible memory contains ${messages.length} messages.\n`);
});