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
                // this.log( `Move ${move} failed. Blacklisting tile temporarily.` );

                // Increment failure counter for this target
                let currentFailures = failureCounters.get(targetKey) || 0;
                failureCounters.set(targetKey, currentFailures + 1);

                // console.log(failureCounters.get(targetKey))

                // If stuck for 5 tries, abandon the goal for 15 seconds!
                if ( failureCounters.get(targetKey) >= 5 ) {
                    // console.log(`[Stuck] Bumped 5 times. Abandoning target ${targetX},${targetY} for 15s.`);
                    // frustrationBlocks.set(targetKey, Date.now() + 15000);

                    temporaryBlocks.set(targetKey, Date.now() + 15000);

                    failureCounters.set(targetKey, 0); // reset counter after applying frustration block
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
                    // console.log(`The blocked tile (${blockX},${blockY}) has a crate! Setting IsCrateBlocking to true.`);
                    setIsCrateBlocking(true);
                }

                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 2000);

                await new Promise(res => setTimeout(res, 100));
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

            await new Promise(res => setTimeout(res, 100));
        }

        return true;
    }
}

export class SolveCrate extends PlanBase {
    static isApplicableTo ( action ) { return action === 'solve_crate'; }

    async execute ( action, crateX, crateY, targetX, targetY ) {
        if ( this.stopped ) throw [ 'stopped' ];
        
        const beliefSet = new Beliefset();
        
        // Define bounding box to prevent solver timeout (e.g., +/- X tiles around the crate)
        const radius = 3;
        const minX = Math.min(Math.round(me.x), crateX, targetX) - radius;
        const maxX = Math.max(Math.round(me.x), crateX, targetX) + radius;
        const minY = Math.min(Math.round(me.y), crateY, targetY) - radius;
        const maxY = Math.max(Math.round(me.y), crateY, targetY) + radius;

        // 1. Declare Objects (Coordinates)
        for(let i = minX; i <= maxX; i++) beliefSet.objects.push(`x${i}`);
        for(let i = minY; i <= maxY; i++) beliefSet.objects.push(`y${i}`);

        // 2. Declare Grid Connectivity
        for(let i = minX; i < maxX; i++) {
            beliefSet.declare(`left x${i} x${i+1}`);  // x(i) is left of x(i+1)
            beliefSet.declare(`right x${i+1} x${i}`); // x(i+1) is right of x(i)
        }
        for(let j = minY; j < maxY; j++) {
            beliefSet.declare(`down y${j} y${j+1}`);  
            beliefSet.declare(`up y${j+1} y${j}`);
        }

        // 3. Declare Entities
        beliefSet.declare(`agent x${Math.round(me.x)} y${Math.round(me.y)}`);
        // beliefSet.declare(`crate x${crateX} y${crateY}`);

        // 4. Declare Walls (Everything un-walkable)
        for (let x = minX; x <= maxX; x++) {
            for(let y = minY; y <= maxY; y++) {
                const key = `${x}_${y}`;
                const tile = mapBeliefs.get(key);

                // Skip the target crate (already declared above)
                // if (x === crateX && y === crateY) continue;

                // If there's ANOTHER crate here, declare it!
                if (crates.has(key)) {
                    beliefSet.declare(`crate x${x} y${y}`);
                    // continue; 
                }

                // Check if another agent is standing here
                const hasAgent = Array.from(agents.values()).some(
                    a => Math.round(a.x) === x && Math.round(a.y) === y
                );

                // Treat walls, out-of-bounds, or other agents as static walls
                if (!tile || tile.type === '0' || hasAgent) {
                    beliefSet.declare(`wall x${x} y${y}`);
                }
            }
        }

        // 5. Construct Problem
        const pddlProblem = new PddlProblem(
            'push-crate',
            beliefSet.objects.join(' '),
            beliefSet.toPddlString(),
            `and (crate x${targetX} y${targetY})`
        );

        // console.log('PDDL Problem:\n', pddlProblem.toPddlString());

        this.log('Asking PDDL Solver to plan Sokoban path...');
        
        // 6. Call Solver
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
        // 7. Execute Plan directly using Socket
        // Actions look like: { action: 'move-right', args: ['x1', 'x2', 'y1'] }
        for (const steps of plan) {
            if (this.stopped) throw ['stopped during execution'];
            
            const step = steps.action.toLowerCase();
            let moveDir = '';
            if (step.includes('left')) moveDir = 'left';
            if (step.includes('right')) moveDir = 'right';
            if (step.includes('up')) moveDir = 'up';
            if (step.includes('down')) moveDir = 'down';

            if (moveDir) {
                this.log(`PDDL Step: Executing ${steps.action} -> moving ${moveDir}`);
                await socket.emitMove(moveDir);
                await new Promise(res => setTimeout(res, 150)); // Allow server state to update
            }
        }

        crateCooldowns.set(`${crateX}_${crateY}`, Date.now() + 8000); // Cooldown to prevent immediate re-planning on the same crate
        
        return true;
    }
}



// // Export the array so the BDI engine can iterate over available plans
// export const planLibrary = [ GoPickUp, GoDeliver, AStarMove, Explore ];