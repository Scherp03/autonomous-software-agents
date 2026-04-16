// ─── Shared Belief State ──────────────────────────────────────────────────────

/** @type { {id:string, name:string, x:number, y:number, score:number} } */
export const me = { id: '', name: '', x: -1, y: -1, score: 0 };

/** @type { Map<string, {x:number, y:number, type:string}> } */
export const mapBeliefs = new Map();

/** @type { {x:number, y:number}[] } */
export const deliveryTiles = [];

/** @type { {x:number, y:number}[] } */
export const spawnTiles = [];

/** @type { Map<string, {id:string, x:number, y:number, reward:number, carriedBy?:string}> } */
export const parcels = new Map();
