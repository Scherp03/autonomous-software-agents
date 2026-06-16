import { writeFileSync, readFileSync, existsSync } from 'fs';
import { socket } from './socket.js';
import { me, mapBeliefs, spawnTiles, spawnWeights, agents, parcels, gameConfig, temporaryBlocks, dynamicRules, CAPACITY, failureCounters, mapWidthxHeight } from './beliefs.js';
import { distance, weightedRandom } from './utils.js';
import { astar, astarDistance } from './pathfinding.js';
import { IntentionDeliberation } from './agent.js';
import { SLAVE_STATUS_PATH, waitForResume, waitForHandoffMoveIn } from './slave-command.js';

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

/**
 * Plan library
 * @type { PlanClass [] }
 */
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

    // refers to the caller of the plan, for example an IntentionDeliberation
    #parent;

    /**
     * @param { PlanBase } parent
     */
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
    
    /**
     * @type { function( string, ...any ) : boolean } 
     */
    static isApplicableTo ( explore ) { return explore == 'explore'; }

    /**
     * @type { function( string, ...any ) : Promise<boolean> } 
     */
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
                // this.log( 'explore failed to go_to target', target, 'error:', error );
            }
        }
    
        const dirs = ['up', 'down', 'left', 'right'];
        const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
        await socket.emitMove(randomDir);
        // await new Promise(res => setTimeout(res, 100)); 
        
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
        if ( id && [ 'left', 'right', 'top', 'bottom' ].includes( id ) )
            dynamicRules.edgeRules.delete( id );
        else
            dynamicRules.bonusTiles.delete( `${x}_${y}` );
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
        if ( id && [ 'left', 'right', 'top', 'bottom' ].includes( id ) )
            dynamicRules.edgeRules.delete( id );
        else
            dynamicRules.bonusTiles.delete( `${x}_${y}` );
        for ( const [ parcelId, p ] of parcels )
            if ( p.carriedBy === me.id ) parcels.delete( parcelId );
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
                writeSlaveStatus( { conditionMet: true, condition, x: me.x, y: me.y } );
                console.log( `[slave] GoToMatchingTile arrived at (${me.x},${me.y}), condition "${condition}" met. hold=${hold}` );
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
export class GoToNeighborhood extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'go_to_neighborhood'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, tiles, pts ) {
        if ( this.stopped ) throw [ 'stopped' ];

        // Avoid tiles currently occupied by visible agents, then sort by distance
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
                this.log( 'go_to_neighborhood: failed to reach tile', target, '- trying next' );
            }
        }

        if ( !arrived ) throw [ 'go_to_neighborhood: could not reach any tile' ];

        writeSlaveStatus( { arrived: true, x: me.x, y: me.y } );
        console.log( `[slave] Arrived at neighborhood (${me.x},${me.y}), waiting for RESUME...` );

        await waitForResume();
        console.log( '[slave] RESUME received, holding position...' );

        // Hold position until freeze() stops this plan
        while ( !this.stopped ) {
            await new Promise( r => setTimeout( r, 200 ) );
        }
        return true;
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
                writeSlaveStatus( { edgeArrived: true } );
                console.log( `[go_to_edge] Holding at border (${target.x},${target.y})...` );
                // Hold position until freeze() stops this plan
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

function writeSlaveStatus ( updates ) {
    try {
        const prev = existsSync( SLAVE_STATUS_PATH ) ? JSON.parse( readFileSync( SLAVE_STATUS_PATH, 'utf8' ) ) : {};
        writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { ...prev, ...updates }, null, 2 ) );
    } catch ( _ ) {}
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
export class HandoffSlave extends PlanBase {
    /** @type { function( string, ...any ) : boolean } */
    static isApplicableTo ( action ) { return action === 'handoff_slave'; }

    /** @type { function( string, ...any ) : Promise<boolean> } */
    async execute ( action, T_slave_x, T_slave_y, T_llm_x, T_llm_y, dir_str ) {
        if ( this.stopped ) throw [ 'stopped' ];
        const T_llm    = { x: T_llm_x, y: T_llm_y };
        const ANTI_DIR = oppositeDir( dir_str );
        // T_retreat is where the LLM moves after dropping (one step in ANTI_DIR from T_llm)
        const DIR_DELTA = { right:{dx:1,dy:0}, left:{dx:-1,dy:0}, up:{dx:0,dy:1}, down:{dx:0,dy:-1} }[ dir_str ];
        const T_retreat_key = `${T_llm_x - DIR_DELTA.dx}_${T_llm_y - DIR_DELTA.dy}`;
        // Navigate to T_slave
        await this.subIntention( [ 'go_to', T_slave_x, T_slave_y ] );
        if ( this.stopped ) throw [ 'stopped' ];

        // Signal LLM: slave is in position
        writeSlaveStatus( { handoffPhase: 'atPosition' } );
        console.log( `[handoff-slave] At T_slave (${T_slave_x},${T_slave_y}). Waiting for HANDOFF_MOVE_IN...` );

        // Wait for LLM to drop and vacate T_llm
        await waitForHandoffMoveIn();
        if ( this.stopped ) throw [ 'stopped' ];

        // Step 3: move into T_llm (now vacated by LLM)
        if ( !await socket.emitMove( ANTI_DIR ) ) throw [ 'handoff: slave failed to enter T_llm' ];

        // Step 4: pick up LLM's parcels immediately
        const picked = await socket.emitPickup();
        console.log( `[handoff-slave] Picked up ${picked.length} parcels.` );

        // Step 5: enemy check → drop everything (slave's own + LLM's)
        // Exclude T_retreat — the LLM just moved there and is supposed to be there
        await waitForClearHandoffZone( T_llm, T_retreat_key );
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();

        // Step 6: vacate T_llm so LLM can step in
        if ( !await socket.emitMove( dir_str ) ) throw [ 'handoff: slave failed to vacate T_llm' ];

        // Block T_llm for 5 s so optionsGeneration doesn't propose go_pick_up for the parcels
        // sitting there before the LLM (one step away at T_retreat) can collect them.
        temporaryBlocks.set( `${T_llm_x}_${T_llm_y}`, Date.now() + 5000 );

        // Signal LLM: T_llm is free; reset carriedCount so the monitor doesn't re-trigger immediately
        writeSlaveStatus( { handoffPhase: 'vacated', carriedCount: 0 } );
        console.log( '[handoff-slave] Vacated T_llm. Dance complete.' );
        return true;
    }
}