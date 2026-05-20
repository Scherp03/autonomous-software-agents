export const me = { id: '', name: '', x: -1, y: -1, score: 0 };

/**
 * @type { Map<string, {x:number, y:number, type:string|number}> }
 */
export const mapBeliefs = new Map();

/** @type { {x:number, y:number}[] } */
export const deliveryTiles = [];

/** @type { {x:number, y:number}[] } */
export const spawnTiles = [];

/**
 * @type { Map<string, {id:string, x:number, y:number, reward:number, carriedBy?:string}> }
 */
export const parcels = new Map();

/**
 * Other visible agents, keyed by id. Updated on every sensing event.
 * @type { Map<string, {id:string, name:string, x:number, y:number, score:number}> }
 */
export const agents = new Map();

export const temporaryBlocks = new Map();

/**
 * Parzen window weight for each spawn tile, keyed by 'x_y'.
 * Recomputed whenever the map is updated. Used by Explore for weighted sampling.
 * @type { Map<string, number> }
 */
export const spawnWeights = new Map();

/**
 * Game configuration received from the server via onConfig.
 * Defaults match the server's own defaults so the agent behaves correctly
 * before the first config event arrives.
 * @type {{
 *   CLOCK: number,
 *   PENALTY: number,
 *   AGENT_TIMEOUT: number,
 *   BROADCAST_LOGS: boolean,
 *   GAME: {
 *     title: string,
 *     description: string,
 *     maxPlayers: number,
 *     map: { width: number, height: number },
 *     parcels: { generation_event: string, decaying_event: string, max: number, reward_avg: number, reward_variance: number },
 *     player: { movement_duration: number, observation_distance: number, capacity: number }
 *   }
 * }}
 */
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
