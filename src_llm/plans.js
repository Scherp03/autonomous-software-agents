import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { socket } from './socket.js';
import { me, mapBeliefs, spawnTiles, spawnWeights, agents, parcels, gameConfig, temporaryBlocks, failureCounters, CAPACITY, dynamicRules, deliveryTiles, handoffState, mapWidthxHeight } from './beliefs.js';
import { distance, weightedRandom } from './utils.js';
import { astar, astarDistance } from './pathfinding.js';
import { IntentionDeliberation } from './agent.js';

const __dir = dirname( fileURLToPath( import.meta.url ) );
const SLAVE_STATUS_PATH  = join( __dir, '..', 'slave-status.json' );
const SLAVE_COMMAND_PATH = join( __dir, '..', 'slave-command.json' );

/**
 * @typedef { {
 *      stop: ()=>void,
 *      stopped: boolean,
 *      log: (...arg0: any[])=>void,
 *      subIntention: (predicate: any) => Promise<any>,
 *      execute: function (string, ...any) : Promise<boolean>
 * } } Plan
 */

/**
 * @typedef { {
 *      name: string,
 *      isApplicableTo: function (string, ...any) : boolean,
 *      prototype: Plan
 * } } PlanClass
 */

/** @type { PlanClass [] } */
export const planLibrary = [];

/**
 * @abstract
 */
class PlanBase {
    #stopped = false;
    stop () {
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) i.stop();
    }
    get stopped () { return this.#stopped; }

    #parent;
    /** @param { PlanBase } parent */
    constructor ( parent ) { this.#parent = parent; }

    /** @type { function(...any): void } */
    log ( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    /** @type { IntentionDeliberation [] } */
    #sub_intentions = [];

    /**
     * @param { [string, ...any] } predicate
     * @returns { Promise<boolean> }
     */
    async subIntention ( predicate ) {
        const sub = new IntentionDeliberation( this, predicate );
        this.#sub_intentions.push( sub );
        return sub.achieve();
    }
}

/**
 * @implements { Plan }
 */
export class Explore extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( explore ) { return explore == 'explore'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute () {
        if ( this.stopped ) throw [ 'stopped' ];

        let target;

        if ( spawnTiles.length > 0 ) {
            const farSpawns = spawnTiles.filter( t => astarDistance(me, t) > 2 );
            const candidates = farSpawns.length > 0 ? farSpawns : spawnTiles;
            const h     = gameConfig.GAME.player.observation_distance;
            const twoH2 = 2 * h * h;
            const weights = candidates.map( t => {
                const kdeWeight  = spawnWeights.get( `${t.x}_${t.y}` ) ?? 1;
                const dx = t.x - me.x;
                const dy = t.y - me.y;
                const proxWeight = Math.exp( -(dx * dx + dy * dy) / twoH2 );
                return kdeWeight * proxWeight;
            } );
            target = weightedRandom( candidates, weights );
        } else {
            const walkable = Array.from( mapBeliefs.values() ).filter( t => t.type !== '0' );
            const farTiles = walkable.filter( t => astarDistance(me, t) > 3 );
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
                this.log( 'explore failed to go_to target', target, 'error:', error );
            }
        }

        const dirs = ['up', 'down', 'left', 'right'];
        const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
        await socket.emitMove(randomDir);

        return true;
    }
}

/**
 * @implements { Plan }
 */
export class GoPickUp extends PlanBase {
    /**
     * @type { function( string, ...any ) : boolean }
     */
    static isApplicableTo ( go_pick_up, x, y, id ) { return go_pick_up == 'go_pick_up'; }

    /**
     * @type { function( string, ...any ) : Promise<boolean> }
     */
    async execute ( go_pick_up, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );

        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPickup();
        return true;
    }
}

/**
 * @implements { Plan }
 */
export class GoDeliver extends PlanBase {
    /**
     * @type { function( string, ...any ) : boolean }
     */
    static isApplicableTo ( go_deliver ) { return go_deliver == 'go_deliver'; }

    /**
     * @type { function( string, ...any ) : Promise<boolean> }
     */
    async execute ( go_deliver, x, y ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );

        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();
        // Remove delivered parcels from beliefs to prevent re-planning on them.
        for ( const [ id, p ] of parcels ) {
            if ( p.carriedBy === me.id ) parcels.delete( id );
        }
        return true;
    }
}

/**
 * @implements { Plan }
 */
export class AStarMove extends PlanBase {
    /**
     * @type { function( string, ...any ) : boolean }
     */
    static isApplicableTo ( go_to ) { return go_to == 'go_to'; }

    /**
     * @type { function( string, ...any ) : Promise<boolean> }
     */
    async execute ( go_to, targetX, targetY ) {
        targetX = Math.round(targetX);
        targetY = Math.round(targetY);
        const targetKey = `${targetX}_${targetY}`;

        while ( Math.round(me.x) !== targetX || Math.round(me.y) !== targetY ) {
            if ( this.stopped ) throw [ 'stopped' ];

            const path = astar( { x: me.x, y: me.y }, { x: targetX, y: targetY } );

            if ( !path || path.length == 0 ) {
                throw [ 'no path to', targetX, targetY ];
            }

            const move = path[ 0 ];
            const result = await socket.emitMove( move );

            if ( !result ) {
                let currentFailures = failureCounters.get(targetKey) || 0;
                failureCounters.set(targetKey, currentFailures + 1);

                // After 5 failed moves, block target for 15s
                if ( failureCounters.get(targetKey) >= 5 ) {
                    console.log(`[Stuck] Bumped 5 times. Abandoning target ${targetX},${targetY} for 15s.`);
                    temporaryBlocks.set(targetKey, Date.now() + 15000);
                    failureCounters.set(targetKey, 0);
                    throw [ 'stuck', targetX, targetY ];
                }

                let blockX = Math.round(me.x);
                let blockY = Math.round(me.y);
                if (move == 'right') blockX += 1;
                if (move == 'left')  blockX -= 1;
                if (move == 'up')    blockY += 1;
                if (move == 'down')  blockY -= 1;

                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 1000);
                continue;
            }

            // Opportunistic pickup: grab unclaimed parcel on the new tile without interrupting the plan.
            const { x: newX, y: newY } = result;
            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
            if ( carried.length < CAPACITY ) {
                const parcelOnTile = Array.from( parcels.values() ).some(
                    p => !p.carriedBy &&
                         Math.round( p.x ) === Math.round( newX ) &&
                         Math.round( p.y ) === Math.round( newY ) &&
                         p.reward < dynamicRules.parcelMaxReward
                );
                if ( parcelOnTile ) await socket.emitPickup();
            }
        }

        return true;
    }
}

/**
 * @implements { Plan }
 */
export class GoToBonus extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'go_to_bonus'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );

        if (id && ['left', 'right', 'top', 'bottom'].includes(id)) {
            dynamicRules.edgeRules.delete(id);
        } else {
            dynamicRules.bonusTiles.delete(`${x}_${y}`);
        }
        return true;
    }
}

/**
 * @implements { Plan }
 */
export class DropOnTile extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'drop_on_tile'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();

        if (id && ['left', 'right', 'top', 'bottom'].includes(id)) {
            dynamicRules.edgeRules.delete(id);
        } else {
            dynamicRules.bonusTiles.delete(`${x}_${y}`);
        }

        for ( const [ parcelId, p ] of parcels ) {
            if ( p.carriedBy === me.id ) parcels.delete( parcelId );
        }
        return true;
    }
}

/**
 * @implements { Plan }
 */
export class GoToMatchingTile extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'go_to_matching_tile'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, condition, pts, hold = false ) {
        if ( this.stopped ) throw [ 'stopped' ];

        let fn;
        try { fn = new Function( 'x', 'y', `return !!(${condition})` ); }
        catch ( e ) { throw [ `go_to_matching_tile: invalid condition: ${condition}` ]; }

        const candidates = Array.from( mapBeliefs.values() )
            .filter( t => t.type !== '0' && fn( t.x, t.y ) )
            .sort( ( a, b ) => astarDistance( me, a ) - astarDistance( me, b ) );

        if ( candidates.length === 0 )
            throw [ `go_to_matching_tile: no walkable tiles match: ${condition}` ];

        for ( const target of candidates ) {
            if ( this.stopped ) throw [ 'stopped' ];
            try {
                await this.subIntention( [ 'go_to', target.x, target.y ] );
                // Wait for slave to arrive before proceeding
                const slaveDeadline = Date.now() + 60000;
                while ( Date.now() < slaveDeadline ) {
                    if ( this.stopped ) throw [ 'stopped' ];
                    try {
                        if ( existsSync( SLAVE_STATUS_PATH ) ) {
                            const s = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
                            if ( s.conditionMet === true && s.condition === condition ) break;
                        }
                    } catch ( _ ) {}
                    await new Promise( r => setTimeout( r, 200 ) );
                }
                console.log( `[go_to_matching_tile] Arrived at (${me.x},${me.y}). hold=${hold}` );
                if ( hold ) {
                    while ( !this.stopped ) {
                        await new Promise( r => setTimeout( r, 200 ) );
                    }
                }
                return true;
            } catch ( _ ) {}
        }

        throw [ 'go_to_matching_tile: could not reach any matching tile' ];
    }
}

/**
 * @implements { Plan }
 */
export class GoToEdge extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'go_to_edge'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, pts ) {
        if ( this.stopped ) throw [ 'stopped' ];

        const { x: maxX, y: maxY, minX, minY } = mapWidthxHeight;

        const borderTiles = Array.from( mapBeliefs.values() ).filter( t =>
            t.type !== '0' &&
            ( t.x === minX || t.x === maxX || t.y === minY || t.y === maxY )
        );

        if ( borderTiles.length === 0 )
            throw [ 'go_to_edge: no border tiles found (map not loaded yet?)' ];

        const sorted = borderTiles.sort( ( a, b ) =>
            astarDistance( me, a ) - astarDistance( me, b ) );

        for ( const target of sorted ) {
            if ( this.stopped ) throw [ 'stopped' ];
            try {
                await this.subIntention( [ 'go_to', target.x, target.y ] );
                // Wait for slave to reach the border
                const slaveDeadline = Date.now() + 60000;
                while ( Date.now() < slaveDeadline ) {
                    if ( this.stopped ) throw [ 'stopped' ];
                    try {
                        if ( existsSync( SLAVE_STATUS_PATH ) ) {
                            const s = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
                            if ( s.edgeArrived === true ) break;
                        }
                    } catch ( _ ) {}
                    await new Promise( r => setTimeout( r, 200 ) );
                }
                // Hold position until freeze() stops this plan
                console.log( `[go_to_edge] Holding at border (${target.x},${target.y})...` );
                while ( !this.stopped ) {
                    await new Promise( r => setTimeout( r, 200 ) );
                }
                return true;
            } catch ( _ ) {
                // AStarMove applied temporaryBlocks for the stuck tile; try the next one
            }
        }

        throw [ 'go_to_edge: could not reach any border tile' ];
    }
}

// ─── Handoff helpers ─────────────────────────────────────────────────────────

function oppositeDir ( d ) { return { right: 'left', left: 'right', up: 'down', down: 'up' }[ d ]; }

async function pollSlaveHandoffPhase ( phase, timeout = 30000 ) {
    const deadline = Date.now() + timeout;
    while ( Date.now() < deadline ) {
        try {
            if ( existsSync( SLAVE_STATUS_PATH ) ) {
                const s = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
                if ( s.handoffPhase === phase ) return;
            }
        } catch ( _ ) {}
        await new Promise( r => setTimeout( r, 200 ) );
    }
    throw [ `handoff: timeout waiting for slave phase '${phase}'` ];
}

async function waitForClearHandoffZone ( T_llm, excludeKey = null, timeout = 60000 ) {
    const deadline = Date.now() + timeout;
    const watched = new Set( [
        `${T_llm.x}_${T_llm.y}`,
        `${T_llm.x + 1}_${T_llm.y}`, `${T_llm.x - 1}_${T_llm.y}`,
        `${T_llm.x}_${T_llm.y + 1}`, `${T_llm.x}_${T_llm.y - 1}`,
    ] );
    while ( Date.now() < deadline ) {
        const clear = Array.from( agents.values() ).every( a => {
            const key = `${Math.round( a.x )}_${Math.round( a.y )}`;
            if ( key === excludeKey ) return true; // ignore known partner position
            return !watched.has( key );
        } );
        if ( clear ) return;
        await new Promise( r => setTimeout( r, 1000 ) );
    }
    throw [ 'handoff: timeout waiting for clear zone around T_llm' ];
}

/**
 * @implements { Plan }
 */
export class HandoffLLM extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'handoff_llm'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, T_llm_x, T_llm_y, T_slave_x, T_slave_y, dir_str ) {
        if ( this.stopped ) throw [ 'stopped' ];
        const T_llm    = { x: T_llm_x, y: T_llm_y };
        const ANTI_DIR = oppositeDir( dir_str );
        console.log( `[handoff-llm] Start — T_llm(${T_llm_x},${T_llm_y}) T_slave(${T_slave_x},${T_slave_y}) dir=${dir_str}` );

        try {
            // Tell slave where to go and send corridor geometry
            writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify(
                { cmd: 'HANDOFF_GOTO', T_slave_x, T_slave_y, T_llm_x, T_llm_y, dir: dir_str } ) );

            // LLM navigates to T_llm
            await this.subIntention( [ 'go_to', T_llm_x, T_llm_y ] );
            if ( this.stopped ) throw [ 'stopped' ];

            // Wait for slave to reach T_slave
            await pollSlaveHandoffPhase( 'atPosition' );
            if ( this.stopped ) throw [ 'stopped' ];

            // Enemy check, then LLM drops at T_llm (slave tile excluded — it's supposed to be there)
            await waitForClearHandoffZone( T_llm, `${T_slave_x}_${T_slave_y}` );
            if ( this.stopped ) throw [ 'stopped' ];
            await socket.emitPutdown();

            // LLM vacates T_llm
            if ( !await socket.emitMove( ANTI_DIR ) ) throw [ 'handoff: LLM failed to vacate T_llm' ];

            // Signal slave to start its side of the dance
            writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'HANDOFF_MOVE_IN' } ) );

            // Wait for slave to complete and vacate T_llm (90s: slave's enemy check can take up to 60s)
            await pollSlaveHandoffPhase( 'vacated', 90000 );
            if ( this.stopped ) throw [ 'stopped' ];

            // LLM moves back to T_llm and picks up everything
            if ( !await socket.emitMove( dir_str ) ) throw [ 'handoff: LLM failed to re-enter T_llm' ];
            const picked = await socket.emitPickup();
            console.log( `[handoff-llm] Picked up ${picked.length} parcels. Delivering...` );

            // Deliver to nearest delivery tile
            const nearestDelivery = deliveryTiles.reduce(
                ( best, t ) => { const d = distance( me, t ); return d < best.d ? { t, d } : best; },
                { t: null, d: Infinity }
            ).t;
            if ( nearestDelivery )
                await this.subIntention( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );

            console.log( '[handoff-llm] Complete.' );
            return true;
        } finally {
            handoffState.lastCompletedAt = Date.now();
            handoffState.inProgress = false;
        }
    }
}

/**
 * @implements { Plan }
 */
export class GoToNeighborhood extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'go_to_neighborhood'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, tiles, pts ) {
        if ( this.stopped ) throw [ 'stopped' ];

        // Avoid tiles occupied by visible agents, then sort by distance
        const occupiedKeys = new Set( Array.from( agents.values() ).map( a => `${Math.round(a.x)}_${Math.round(a.y)}` ) );
        const sorted = [ ...tiles ]
            .filter( t => !occupiedKeys.has( `${t.x}_${t.y}` ) )
            .sort( (a, b) => distance( me, a ) - distance( me, b ) );

        if ( sorted.length === 0 ) throw [ 'go_to_neighborhood: no available tiles' ];

        let arrived = false;
        for ( const target of sorted ) {
            if ( this.stopped ) throw [ 'stopped' ];
            try {
                await this.subIntention( [ 'go_to', target.x, target.y ] );
                arrived = true;
                break;
            } catch ( err ) {
                this.log( 'go_to_neighborhood: failed to reach', target, '- trying next' );
            }
        }

        if ( !arrived ) throw [ 'go_to_neighborhood: could not reach any tile' ];

        console.log( `[llm] Arrived at neighborhood (${me.x},${me.y}), waiting for slave...` );

        // Poll slave-status.json until slave arrives (60s timeout)
        const deadline = Date.now() + 60000;
        while ( Date.now() < deadline ) {
            if ( this.stopped ) throw [ 'stopped' ];
            try {
                if ( existsSync( SLAVE_STATUS_PATH ) ) {
                    const status = JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) );
                    if ( status.arrived ) break;
                }
            } catch ( _ ) {}
            await new Promise( r => setTimeout( r, 200 ) );
        }

        // Signal slave to resume and mark mission complete
        writeFileSync( SLAVE_COMMAND_PATH, JSON.stringify( { cmd: 'RESUME' } ) );
        try {
            const prev = existsSync( SLAVE_STATUS_PATH ) ? JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) ) : {};
            writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { ...prev, neighborhoodDone: true }, null, 2 ) );
        } catch ( _ ) {}

        console.log( '[llm] Both in neighborhood — RESUME sent to slave.' );

        // Hold until freeze() stops this plan
        while ( !this.stopped ) {
            await new Promise( r => setTimeout( r, 200 ) );
        }
        return true;
    }
}
