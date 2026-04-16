import { socket } from './socket.js';
import { me, mapBeliefs, spawnTiles, temporaryBlocks } from './beliefs.js';
import { distance } from './utils.js';
import { bfs } from './pathfinding.js';
import { IntentionDeliberation } from './agent.js';

export const planLibrary = [];

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

export class Explore extends PlanBase {
    static isApplicableTo ( explore ) { return explore === 'explore'; }

    async execute () {
        if ( this.stopped ) throw [ 'stopped' ];
        
        let target;

        if ( spawnTiles.length > 0 ) {
            const farSpawns = spawnTiles.filter( t => distance(me, t) > 2 );
            if ( farSpawns.length > 0 ) {
                target = farSpawns[ Math.floor( Math.random() * farSpawns.length ) ];
            } else {
                target = spawnTiles[ Math.floor( Math.random() * spawnTiles.length ) ];
            }
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
            } catch (error) {}
        }
        
        const dirs = ['up', 'down', 'left', 'right'];
        const randomDir = dirs[Math.floor(Math.random() * dirs.length)];
        await socket.emitMove(randomDir);
        await new Promise(res => setTimeout(res, 200)); 
        
        return true;
    }
}

export class GoPickUp extends PlanBase {
    static isApplicableTo ( go_pick_up ) { return go_pick_up === 'go_pick_up'; }

    async execute ( go_pick_up, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );
        
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPickup();
        return true;
    }
}

export class GoDeliver extends PlanBase {
    static isApplicableTo ( go_deliver ) { return go_deliver === 'go_deliver'; }

    async execute ( go_deliver, x, y ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );
        
        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();
        return true;
    }
}

export class BfsMove extends PlanBase {
    static isApplicableTo ( go_to ) { return go_to === 'go_to'; }

    async execute ( go_to, targetX, targetY ) {
        targetX = Math.round(targetX);
        targetY = Math.round(targetY);

        while ( Math.round(me.x) !== targetX || Math.round(me.y) !== targetY ) {
            if ( this.stopped ) throw [ 'stopped' ];

            const path = bfs( { x: me.x, y: me.y }, { x: targetX, y: targetY } );
            
            if ( !path || path.length === 0 ) {
                await new Promise(res => setTimeout(res, 500)); 
                throw [ 'no path to', targetX, targetY ]; 
            }

            const move = path[ 0 ];
            const result = await socket.emitMove( move );

            if ( !result ) {
                this.log( `Move ${move} failed. Blacklisting tile temporarily.` );
                
                let blockX = Math.round(me.x);
                let blockY = Math.round(me.y);
                if (move === 'right') blockX += 1;
                if (move === 'left')  blockX -= 1;
                if (move === 'up')    blockY += 1;
                if (move === 'down')  blockY -= 1;

                temporaryBlocks.set(`${blockX}_${blockY}`, Date.now() + 3000);
                
                await new Promise(res => setTimeout(res, 200)); 
                continue; 
            }

            await new Promise(res => setTimeout(res, 150));
        }

        return true;
    }
}

// // Export the array so the BDI engine can iterate over available plans
// export const planLibrary = [ GoPickUp, GoDeliver, BfsMove, Explore ];