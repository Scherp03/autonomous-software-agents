import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;    
const TOKEN = process.env.TOKEN;

const socket = DjsConnect(
    HOST,
    TOKEN
    );


// /** @type {Map<string,{id:string, name:string, x:number, y:number, score:number, timestamp:number, direction:string}[]>} */
// const beliefset = new Map();
// const start = Date.now();

//     /** @type {number} */
// var OBSERVATION_DISTANCE;
// socket.onConfig( config => OBSERVATION_DISTANCE = config.GAME.player.observation_distance );




// ─── Utility ──────────────────────────────────────────────────────────────────

/** @type { function ({x:number,y:number},{x:number,y:number}):number } */
function distance( {x:x1, y:y1}, {x:x2, y:y2} ) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) );
    const dy = Math.abs( Math.round(y1) - Math.round(y2) );
    return dx + dy;
}

// ─── Belief Revision ─────────────────────────────────────────────────────────

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = { id: '', name: '', x: -1, y: -1, score: 0 };

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id    = id;
    me.name  = name;
    me.x     = x ?? me.x;
    me.y     = y ?? me.y;
    me.score = score;
} );

/**
 * @type { Map<string, {x:number, y:number, type:string|number, delivery?:boolean}> }
 */
const mapBeliefs = new Map();

/** @type { {x:number, y:number}[] } */
const deliveryTiles = [];

/** @type { {x:number, y:number}[] } */
const spawnTiles = []; // ADDED

socket.on( 'map', async (width, height, tile)  => {
    const tiles = Array.isArray(tile) ? tile : (tile || []);
    for ( const tile of tiles ) {
        mapBeliefs.set( `${tile.x}_${tile.y}`, tile );
        
        if ( tile.type === '2') {
            if ( !deliveryTiles.find( t => t.x === tile.x && t.y === tile.y ) ) {
                deliveryTiles.push( {x: tile.x, y: tile.y} );
            }
        }
        // ADDED: Track Spawn Tiles
        if ( tile.type === '1') {
            if ( !spawnTiles.find( t => t.x === tile.x && t.y === tile.y ) ) {
                spawnTiles.push( {x: tile.x, y: tile.y} );
            }
        }
    }
});

socket.onTile( ( tile ) => {
    const {x, y, type} = tile;
    mapBeliefs.set( `${x}_${y}`, tile );
    
    if ( (type === '2') && !deliveryTiles.find( t => t.x === x && t.y === y ) ) {
        deliveryTiles.push( {x, y} );
    }
    // ADDED: Track Spawn Tiles dynamically
    if ( (type === '1') && !spawnTiles.find( t => t.x === x && t.y === y ) ) {
        spawnTiles.push( {x, y} );
    }
} );

/**
 * @type { Map<string, {id:string, x:number, y:number, reward:number, carriedBy?:string}> }
 */
const parcels = new Map();

socket.onSensing( ( sensing ) => {
    for ( const p of sensing.parcels )
        parcels.set( p.id, p );
    for ( const [id] of parcels )
        if ( !sensing.parcels.find( p => p.id === id ) )
            parcels.delete( id );
} );

// ─── Pathfinding (BFS) ────────────────────────────────────────────────────────

const DIRS = [
    { dir: 'right', dx:  1, dy:  0, blockedBy: '←' },
    { dir: 'left',  dx: -1, dy:  0, blockedBy: '→' },
    { dir: 'up',    dx:  0, dy:  1, blockedBy: '↓' },
    { dir: 'down',  dx:  0, dy: -1, blockedBy: '↑' },
];

// ADDED: Stores temporarily blocked tiles and their expiration timestamp
const temporaryBlocks = new Map(); 

function canEnter( nx, ny, blockedBy ) {
    const key = `${nx}_${ny}`;
    
    // Check if this tile was recently blocked by a failed move
    if ( temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now() ) {
        return false; 
    }

    const tile = mapBeliefs.get( key );
    if ( !tile || tile.type === '0' ) return false;
    if ( tile.type === blockedBy ) return false;
    return true;
}

function bfs( from, to ) {
    // Round to integers so the pathfinder doesn't break when coordinates are floats mid-move
    const startX = Math.round(from.x);
    const startY = Math.round(from.y);
    const targetX = Math.round(to.x);
    const targetY = Math.round(to.y);

    if ( startX === targetX && startY === targetY ) return [];

    const queue   = [ { x: startX, y: startY, path: [] } ];
    const visited = new Set( [ `${startX}_${startY}` ] );

    while ( queue.length > 0 ) {
        const { x, y, path } = queue.shift();

        for ( const { dir, dx, dy, blockedBy } of DIRS ) {
            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx}_${ny}`;
            
            if ( visited.has(key) ) continue;
            if ( !canEnter(nx, ny, blockedBy) ) continue;

            const newPath = [ ...path, dir ];
            if ( nx === targetX && ny === targetY ) return newPath;

            visited.add( key );
            queue.push( { x: nx, y: ny, path: newPath } );
        }
    }

    return null; 
}

// ─── Options Generation ───────────────────────────────────────────────────────

// function optionsGeneration () {
//     if ( !me.id ) return;

//     const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );

//     // 1. Deliver: If we carry something AND know where to put it
//     if ( carried.length > 0 && deliveryTiles.length > 0 ) {
//         const nearest = [ ...deliveryTiles ]
//             .sort( (a, b) => distance(me, a) - distance(me, b) )
//             [ 0 ];
//         myAgent.push( [ 'go_deliver', nearest.x, nearest.y ] );
//         return; // Prevents pushing multiple intentions
//     }
    
//     // 2. Pick up: Find the best available parcel
//     const available = Array.from( parcels.values() ).filter( p => {
//         if ( p.carriedBy ) return false;
//         return p.reward > 10;
//     } );
   
//     if ( available.length > 0 ) {
//         const best = [ ...available ]
//             .sort( (a, b) =>
//                 ( b.reward / ( distance(me, b) + 1 ) ) -
//                 ( a.reward / ( distance(me, a) + 1 ) )
//             )
//             [ 0 ];

//         myAgent.push( [ 'go_pick_up', best.x, best.y, best.id ] );
//         return; // Prevents pushing multiple intentions
//     }

//     // 3. Explore: If we can't deliver or pick up, uncover the map!
//     // This triggers if we carry a parcel but don't know a delivery tile yet, 
//     // or if the map is just empty.
//     myAgent.push( [ 'explore' ] );
// }

function optionsGeneration () {
    if ( !me.id ) return;

    const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
    const available = Array.from( parcels.values() ).filter( p => {
        if ( p.carriedBy ) return false;
        return p.reward > 10;
    } );

    // Pre-calculate the best available parcel
    let bestPickUp = null;
    if ( available.length > 0 ) {
        bestPickUp = [ ...available ].sort( (a, b) => {
            const scoreA = a.reward / ( distance(me, a) + 1 );
            const scoreB = b.reward / ( distance(me, b) + 1 );
            if (scoreB !== scoreA) return scoreB - scoreA;
            return a.id.localeCompare(b.id); // Tie-breaker prevents intention flickering
        })[ 0 ];
    }

    // 1. Deliver (with Opportunistic Pickup)
    if ( carried.length > 0 && deliveryTiles.length > 0 ) {
        const nearestDelivery = [ ...deliveryTiles ].sort( (a, b) => {
            const distDiff = distance(me, a) - distance(me, b);
            if (distDiff !== 0) return distDiff;
            return a.x - b.x; // Tie-breaker 
        })[ 0 ];

        // OPPORTUNISTIC PICKUP: If we are heading to deliver, but an available 
        // parcel is very close (<= 2 tiles away), detour and pick it up!
        if ( bestPickUp && distance(me, bestPickUp) <= 2 ) {
            myAgent.push( [ 'go_pick_up', bestPickUp.x, bestPickUp.y, bestPickUp.id ] );
            return;
        }

        // Otherwise, proceed to delivery
        myAgent.push( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );
        return; 
    }
    
    // 2. Pick up: If not carrying anything (or no delivery tiles known), find a parcel
    if ( bestPickUp ) {
        myAgent.push( [ 'go_pick_up', bestPickUp.x, bestPickUp.y, bestPickUp.id ] );
        return;
    }

    // 3. Explore: If nothing else to do, uncover the map
    myAgent.push( [ 'explore' ] );
}

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );

// ─── Intention Revision ───────────────────────────────────────────────────────

class IntentionRevision {
    #intention_queue = [];
    get intention_queue () { return this.#intention_queue; }

    async loop () {
        while ( true ) {
            if ( this.intention_queue.length > 0 ) {
                const intention = this.intention_queue[ 0 ];

                if ( intention.predicate[ 0 ] === 'go_pick_up' ) {
                    const id = intention.predicate[ 3 ];
                    const p  = parcels.get( id );
                    if ( !p || p.carriedBy ) {
                        this.intention_queue.shift();
                        continue;
                    }
                }

                await intention.achieve().catch( err => {
                    // Intentionally swallow errors so the loop continues
                } );

                this.intention_queue.shift();
            }
            await new Promise( res => setImmediate( res ) );
        }
    }

    log ( ...args ) { console.log( ...args ); }

    async push ( predicate ) {}
}

class IntentionRevisionReplace extends IntentionRevision {
    async push ( predicate ) {
        const last = this.intention_queue.at( -1 );
        if ( last && last.predicate.join(' ') === predicate.join(' ') ) return;

        const intention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( intention );

        if ( last ) last.stop();
    }
}

const myAgent = new IntentionRevisionReplace();
myAgent.loop();

// ─── Intention Deliberation ───────────────────────────────────────────────────

class IntentionDeliberation {
    #current_plan;
    #stopped = false;
    get stopped () { return this.#stopped; }
    
    stop () {
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    #parent;
    #predicate;
    get predicate () { return this.#predicate; }

    constructor ( parent, predicate ) {
        this.#parent    = parent;
        this.#predicate = predicate;
    }

    log ( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    #started = false;
    async achieve () {
        if ( this.#started ) return false;
        this.#started = true;

        for ( const planClass of planLibrary ) {
            if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
            
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                this.#current_plan = new planClass( this.#parent );
                try {
                    const res = await this.#current_plan.execute( ...this.predicate );
                    return res || false;
                } catch ( error ) {
                    this.log( 'failed', ...this.predicate, 'error:', error );
                }
            }
        }

        if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
        throw [ 'no plan satisfied', ...this.predicate ];
    }
}

// ─── Plan Library ─────────────────────────────────────────────────────────────

const planLibrary = [];

class PlanBase {
    #stopped = false;
    stop () {
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) i.stop();
    }
    get stopped () { return this.#stopped; }

    #parent;
    constructor ( parent ) { this.#parent = parent; }

    log ( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    #sub_intentions = [];

    async subIntention ( predicate ) {
        const sub = new IntentionDeliberation( this, predicate );
        this.#sub_intentions.push( sub );
        return sub.achieve();
    }
}

// class Explore extends PlanBase {
//     static isApplicableTo ( explore ) { return explore === 'explore'; }

//     async execute () {
//         if ( this.stopped ) throw [ 'stopped' ];
        
//         // Get all walkable tiles we know about
//         const walkable = Array.from( mapBeliefs.values() ).filter( t => t.type !== '0' );
        
//         // Try to pick a known tile that is a few steps away to encourage map traversal
//         const farTiles = walkable.filter( t => distance(me, t) > 3 );
//         let target;
        
//         if ( farTiles.length > 0 ) {
//             target = farTiles[ Math.floor( Math.random() * farTiles.length ) ];
//         } else if ( walkable.length > 0 ) {
//             target = walkable[ Math.floor( Math.random() * walkable.length ) ];
//         }

//         if ( target ) {
//             try {
//                 // Leverage your existing BFS move logic
//                 await this.subIntention( [ 'go_to', target.x, target.y ] );
//                 return true;
//             } catch (error) {
//                 // Pathfinding might occasionally fail. 
//                 // Catching the error allows it to fall through to the random step below.
//             }
//         }
        
//         // Fallback: take a single step in a random direction if all else fails
//         const dirs = ['up', 'down', 'left', 'right'];
//         const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
//         await socket.emitMove(randomDir);
        
//         // Brief pause so we don't spam the server if we get stuck
//         await new Promise(res => setTimeout(res, 200)); 
//         return true;
//     }
// }

class Explore extends PlanBase {
    static isApplicableTo ( explore ) { return explore === 'explore'; }

    async execute () {
        if ( this.stopped ) throw [ 'stopped' ];
        
        let target;

        // Prioritize known spawn areas
        if ( spawnTiles.length > 0 ) {
            // Pick a random spawn tile (prefer ones further away to keep the agent moving)
            const farSpawns = spawnTiles.filter( t => distance(me, t) > 2 );
            if ( farSpawns.length > 0 ) {
                target = farSpawns[ Math.floor( Math.random() * farSpawns.length ) ];
            } else {
                target = spawnTiles[ Math.floor( Math.random() * spawnTiles.length ) ];
            }
        } else {
            // Fallback: If no spawns known yet, explore random walkable space
            const walkable = Array.from( mapBeliefs.values() ).filter( t => t.type !== '0' );
            const farTiles = walkable.filter( t => distance(me, t) > 3 );
            if ( farTiles.length > 0 ) {
                target = farTiles[ Math.floor( Math.random() * farTiles.length ) ];
            } else if ( walkable.length > 0 ) {
                target = walkable[ Math.floor( Math.random() * walkable.length ) ];
            }
        }

        if ( target ) {
            try {
                await this.subIntention( [ 'go_to', target.x, target.y ] );
                return true;
            } catch (error) {
                // If pathfinding throws an error (like 'no path to'), we do nothing.
                // It will drop to the fallback below, take a random step to unstick, 
                // and then OptionsGeneration will queue a new Explore intention instantly.
            }
        }
        
        // Fallback to unstick the agent
        const dirs = ['up', 'down', 'left', 'right'];
        const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
        await socket.emitMove(randomDir);
        await new Promise(res => setTimeout(res, 200)); 
        
        return true;
    }
}

class GoPickUp extends PlanBase {
    static isApplicableTo ( go_pick_up ) { return go_pick_up === 'go_pick_up'; }

    async execute ( go_pick_up, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );
        
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPickup();
        return true;
    }
}

class GoDeliver extends PlanBase {
    static isApplicableTo ( go_deliver ) { return go_deliver === 'go_deliver'; }

    async execute ( go_deliver, x, y ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );
        
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();
        return true;
    }
}

class BfsMove extends PlanBase {
    static isApplicableTo ( go_to ) { return go_to === 'go_to'; }

    async execute ( go_to, targetX, targetY ) {
        targetX = Math.round(targetX);
        targetY = Math.round(targetY);

        while ( Math.round(me.x) !== targetX || Math.round(me.y) !== targetY ) {
            if ( this.stopped ) throw [ 'stopped' ];

            const path = bfs( { x: me.x, y: me.y }, { x: targetX, y: targetY } );
            
            if ( !path || path.length === 0 ) {
                await new Promise(res => setTimeout(res, 500)); 
                throw [ 'no path to', targetX, targetY ]; // Throwing allows intention to drop and reassess
            }

            const move = path[ 0 ];
            const result = await socket.emitMove( move );

            if ( !result ) {
                this.log( `Move ${move} failed. Blacklisting tile temporarily.` );
                
                // Calculate coordinates of the failed tile
                let blockX = Math.round(me.x);
                let blockY = Math.round(me.y);
                if (move === 'right') blockX += 1;
                if (move === 'left')  blockX -= 1;
                if (move === 'up')    blockY += 1;
                if (move === 'down')  blockY -= 1;

                // Block this specific tile for 3 seconds so BFS routes around it
                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 3000);
                
                await new Promise(res => setTimeout(res, 200)); 
                continue; // Loop restarts, BFS will now ignore the blocked tile!
            }

            await new Promise(res => setTimeout(res, 150));
        }

        return true;
    }
}

planLibrary.push( GoPickUp );
planLibrary.push( GoDeliver );
planLibrary.push( BfsMove );
planLibrary.push( Explore );