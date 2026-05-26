import { writeFileSync } from 'fs';
import { socket } from './socket.js';
import { me, mapBeliefs, spawnTiles, spawnWeights, agents, parcels, gameConfig, temporaryBlocks, dynamicRules } from './beliefs.js';
import { distance, weightedRandom } from './utils.js';
import { astar } from './pathfinding.js';
import { IntentionDeliberation } from './agent.js';
import { SLAVE_STATUS_PATH, waitForResume } from './slave-command.js';

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
            const farSpawns = spawnTiles.filter( t => distance(me, t) > 2 );
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
                this.log( 'explore failed to go_to target', target, 'error:', error );
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
        // After delivery, remove the delivered parcels from beliefs to prevent re-planning on them. 
        for ( const [ id, p ] of parcels ) {                  
            if ( p.carriedBy === me.id ) parcels.delete( id );
        }
        return true;
    }
}

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

        while ( Math.round(me.x) !== targetX || Math.round(me.y) !== targetY ) {
            if ( this.stopped ) throw [ 'stopped' ];

            const path = astar( { x: me.x, y: me.y }, { x: targetX, y: targetY } );
            
            if ( !path || path.length == 0 ) {
                // await new Promise(res => setTimeout(res, 100)); 
                throw [ 'no path to', targetX, targetY ]; 
            }

            const move = path[ 0 ];
            const result = await socket.emitMove( move );

            if ( !result ) {
                this.log( `Move ${move} failed. Blacklisting tile temporarily.` );

                let blockX = Math.round(me.x);
                let blockY = Math.round(me.y);
                if (move == 'right') blockX += 1;
                if (move == 'left')  blockX -= 1;
                if (move == 'up')    blockY += 1;
                if (move == 'down')  blockY -= 1;

                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 1000);

                // await new Promise(res => setTimeout(res, 100));
                continue;
            }

            // Opportunistic pickup: grab any unclaimed parcel on the new tile without
            // interrupting the current plan. Uses the confirmed position from the move result.
            const { x: newX, y: newY } = result;
            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
            if ( carried.length < gameConfig.GAME.player.capacity ) {
                const parcelOnTile = Array.from( parcels.values() ).some(
                    p => !p.carriedBy &&
                         Math.round( p.x ) === Math.round( newX ) &&
                         Math.round( p.y ) === Math.round( newY )
                );
                if ( parcelOnTile ) await socket.emitPickup();
            }

            // await new Promise(res => setTimeout(res, 100));
        }

        return true;
    }
}



export class GoToBonus extends PlanBase {
    static isApplicableTo ( action ) { return action === 'go_to_bonus'; }

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

export class DropOnTile extends PlanBase {
    static isApplicableTo ( action ) { return action === 'drop_on_tile'; }

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

export class GoToNeighborhood extends PlanBase {
    static isApplicableTo ( action ) { return action === 'go_to_neighborhood'; }

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

        writeFileSync( SLAVE_STATUS_PATH, JSON.stringify( { arrived: true, x: me.x, y: me.y }, null, 2 ) );
        console.log( `[slave] Arrived at neighborhood (${me.x},${me.y}), waiting for RESUME...` );

        await waitForResume();
        console.log( '[slave] RESUME received, resuming normal operation.' );
        return true;
    }
}