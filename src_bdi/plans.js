import { socket } from './socket.js';
import { me, mapBeliefs, spawnTiles, spawnWeights, parcels, gameConfig, temporaryBlocks, failureCounters, crateCooldowns, agents } from './beliefs.js';
import { distance, weightedRandom } from './utils.js';
import { astar, astarDistance } from './pathfinding.js';
import { IntentionDeliberation } from './agent.js';
import { onlineSolver, Beliefset, PddlProblem } from "@unitn-asa/pddl-client";
import { crateDomain } from '../planner/pddl.js';
import { crates, setIsCrateBlocking } from './beliefs.js';

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
    static isApplicableTo ( explore ) { return explore == 'explore'; }

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
        await new Promise(res => setTimeout(res, 100));

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
                await new Promise(res => setTimeout(res, 100));
                throw [ 'no path to', targetX, targetY ];
            }

            const move = path[ 0 ];
            const result = await socket.emitMove( move );

            if ( !result ) {
                let currentFailures = failureCounters.get(targetKey) || 0;
                failureCounters.set(targetKey, currentFailures + 1);

                // After 5 failed moves, block target for 15s
                if ( failureCounters.get(targetKey) >= 5 ) {
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
                console.log(`Blacklisting tile (${blockX},${blockY}) temporarily.`);

                if (crates.has(`${blockX}_${blockY}`)) {
                    setIsCrateBlocking(true);
                }

                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 2000);

                await new Promise(res => setTimeout(res, 100));
                continue;
            }

            // Opportunistic pickup: grab unclaimed parcel on the new tile without interrupting the plan.
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

            await new Promise(res => setTimeout(res, 100));
        }

        return true;
    }
}

export class SolveCrate extends PlanBase {
    /**
     * @type { function( string, ...any ) : boolean } 
     */
    static isApplicableTo ( action ) { return action === 'solve_crate'; }

    /**
     * @type { function( string, ...any ) : Promise<boolean> } 
     */
    async execute ( action, crateX, crateY, targetX, targetY ) {
        if ( this.stopped ) throw [ 'stopped' ];

        const beliefSet = new Beliefset();

        // Bounding box around involved positions to keep the solver fast
        const radius = 3;
        const minX = Math.min(Math.round(me.x), crateX, targetX) - radius;
        const maxX = Math.max(Math.round(me.x), crateX, targetX) + radius;
        const minY = Math.min(Math.round(me.y), crateY, targetY) - radius;
        const maxY = Math.max(Math.round(me.y), crateY, targetY) + radius;

        // 1. Declare objects (coordinates)
        for(let i = minX; i <= maxX; i++) beliefSet.objects.push(`x${i}`);
        for(let i = minY; i <= maxY; i++) beliefSet.objects.push(`y${i}`);

        // 2. Declare grid connectivity
        for(let i = minX; i < maxX; i++) {
            beliefSet.declare(`left x${i} x${i+1}`);
            beliefSet.declare(`right x${i+1} x${i}`);
        }
        for(let j = minY; j < maxY; j++) {
            beliefSet.declare(`down y${j} y${j+1}`);
            beliefSet.declare(`up y${j+1} y${j}`);
        }

        // 3. Declare entities
        beliefSet.declare(`agent x${Math.round(me.x)} y${Math.round(me.y)}`);

        // 4. Declare walls (unwalkable tiles, out-of-bounds, and agent-occupied tiles)
        for (let x = minX; x <= maxX; x++) {
            for(let y = minY; y <= maxY; y++) {
                const key = `${x}_${y}`;
                const tile = mapBeliefs.get(key);

                if (crates.has(key)) {
                    beliefSet.declare(`crate x${x} y${y}`);
                }

                const hasAgent = Array.from(agents.values()).some(
                    a => Math.round(a.x) === x && Math.round(a.y) === y
                );

                if (!tile || tile.type === '0' || hasAgent) {
                    beliefSet.declare(`wall x${x} y${y}`);
                }
            }
        }

        // 5. Construct problem
        const pddlProblem = new PddlProblem(
            'push-crate',
            beliefSet.objects.join(' '),
            beliefSet.toPddlString(),
            `and (crate x${targetX} y${targetY})`
        );

        this.log('Asking PDDL Solver to plan Sokoban path...');

        // 6. Call solver
        let plan;
        try {
            plan = await onlineSolver(crateDomain, pddlProblem.toPddlString());
        } catch (err) {
            this.log('PDDL solver failed/timed out. Blacklisting crate tile.');
            temporaryBlocks.set(`${crateX}_${crateY}`, Date.now() + 5000);
            throw ['pddl solver failed or timed out', err];
        }

        if (!plan || plan.length === 0) {
            crateCooldowns.set(`${crateX}_${crateY}`, Date.now() + 8000);
            throw ['no pddl plan found'];
        }

        // 7. Execute plan — actions look like: { action: 'move-right', args: ['x1', 'x2', 'y1'] }
        for (const steps of plan) {
            if (this.stopped) throw ['stopped during execution'];

            const step = steps.action.toLowerCase();
            let moveDir = '';
            if (step.includes('left'))  moveDir = 'left';
            if (step.includes('right')) moveDir = 'right';
            if (step.includes('up'))    moveDir = 'up';
            if (step.includes('down'))  moveDir = 'down';

            if (moveDir) {
                this.log(`PDDL Step: Executing ${steps.action} -> moving ${moveDir}`);
                await socket.emitMove(moveDir);
                await new Promise(res => setTimeout(res, 150));
            }
        }

        // Cooldown to prevent immediate re-planning on the same crate
        crateCooldowns.set(`${crateX}_${crateY}`, Date.now() + 8000);

        return true;
    }
}
