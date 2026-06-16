export const me = { id: '', name: '', x: -1, y: -1, score: 0 };

/** @type { Map<string, {x:number, y:number, type:string|number}> } */
export const mapBeliefs = new Map();

export const crates = new Map();
export const crateTargets = new Map();
export const crateCooldowns = new Map();

/** @type { {x:number, y:number}[] } */
export const deliveryTiles = [];

/** @type { {x:number, y:number}[] } */
export const spawnTiles = [];

/** @type { Map<string, {id:string, x:number, y:number, reward:number, carriedBy?:string}> } */
export const parcels = new Map();

/** @type { Map<string, {id:string, name:string, x:number, y:number, score:number}> } */
export const agents = new Map();

export const temporaryBlocks = new Map();
export const failureCounters = new Map();

/** @type { Map<string, number> } */
export const spawnWeights = new Map();

// Game config received from server; defaults match server defaults.
export const gameConfig = {
    CLOCK: 50,
    PENALTY: 1,
    AGENT_TIMEOUT: 10000,
    BROADCAST_LOGS: false,
    GAME: {
        title: '',
        description: '',
        maxPlayers: 10,
        map: { width: 0, height: 0 },
        parcels: {
            generation_event: '2s',
            decaying_event: '1s',
            max: 5,
            reward_avg: 30,
            reward_variance: 10,
        },
        player: {
            movement_duration: 100,
            observation_distance: 5,
            capacity: 5,
        },
    },
};

export const CAPACITY = 8;

export let IsCrateBlocking = false;

/** @param {boolean} value */
export function setIsCrateBlocking(value) {
    IsCrateBlocking = value;
}
