import { socket } from './connection.js';
import { PlanBase } from './intentions.js';
import { planLibrary } from './plan-library.js';
import { me, parcels, spawnTiles, mapBeliefs } from './beliefs.js';
import { bfs, distance, temporaryBlocks } from './pathfinding.js';

// ─── Plan Library ─────────────────────────────────────────────────────────────

class GoPickUp extends PlanBase {
    static isApplicableTo( go_pick_up ) { return go_pick_up === 'go_pick_up'; }

    async execute( go_pick_up, x, y, id ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );

        if ( this.stopped ) throw [ 'stopped' ];
        // Re-check parcel availability on arrival; another agent may have taken it
        const parcel = parcels.get(id);
        if ( !parcel || parcel.carriedBy ) return false;

        await socket.emitPickup();
        return true;
    }
}

class GoDeliver extends PlanBase {
    static isApplicableTo( go_deliver ) { return go_deliver === 'go_deliver'; }

    async execute( go_deliver, x, y ) {
        if ( this.stopped ) throw [ 'stopped' ];
        await this.subIntention( [ 'go_to', x, y ] );

        if ( this.stopped ) throw [ 'stopped' ];
        await socket.emitPutdown();
        return true;
    }
}

class BfsMove extends PlanBase {
    static isApplicableTo( go_to ) { return go_to === 'go_to'; }

    async execute( go_to, targetX, targetY ) {
        targetX = Math.round(targetX);
        targetY = Math.round(targetY);

        while ( Math.round(me.x) !== targetX || Math.round(me.y) !== targetY ) {
            if ( this.stopped ) throw [ 'stopped' ];

            const path = bfs( { x: me.x, y: me.y }, { x: targetX, y: targetY } );

            if ( !path || path.length === 0 ) {
                await new Promise( res => setTimeout(res, 500) );
                throw [ 'no path to', targetX, targetY ];
            }

            const move   = path[0];
            const result = await socket.emitMove( move );

            if ( !result ) {
                this.log( `Move ${move} failed. Blacklisting tile temporarily.` );

                let blockX = Math.round(me.x);
                let blockY = Math.round(me.y);
                if ( move === 'right' ) blockX += 1;
                if ( move === 'left'  ) blockX -= 1;
                if ( move === 'up'    ) blockY += 1;
                if ( move === 'down'  ) blockY -= 1;

                temporaryBlocks.set( `${blockX}_${blockY}`, Date.now() + 3000 );
                await new Promise( res => setTimeout(res, 200) );
                continue;
            }

            await new Promise( res => setTimeout(res, 150) );
        }

        return true;
    }
}

class Explore extends PlanBase {
    static isApplicableTo( explore ) { return explore === 'explore'; }

    async execute() {
        if ( this.stopped ) throw [ 'stopped' ];

        let target;

        if ( spawnTiles.length > 0 ) {
            // Pick a random spawn tile that is not the agent's current position,
            // so the agent always walks somewhere new instead of staying put.
            const distant = spawnTiles.filter( t => distance(me, t) > 1 );
            const pool    = distant.length > 0 ? distant : spawnTiles;
            target = pool[ Math.floor( Math.random() * pool.length ) ];
        } else {
            // Fallback: move toward a distant walkable tile to uncover the map
            const walkable  = Array.from( mapBeliefs.values() ).filter( t => t.type !== '0' );
            const farTiles  = walkable.filter( t => distance(me, t) > 3 );
            const pool      = farTiles.length > 0 ? farTiles : walkable;
            target = pool.length > 0
                ? pool[ Math.floor( Math.random() * pool.length ) ]
                : null;
        }

        if ( target ) {
            try {
                await this.subIntention( [ 'go_to', target.x, target.y ] );
                return true;
            } catch ( error ) {
                // Pathfinding failed; fall through to random-step unstick
            }
        }

        // Unstick fallback: take a random step so the agent is never fully idle
        const dirs = [ 'up', 'down', 'left', 'right' ];
        await socket.emitMove( dirs[ Math.floor( Math.random() * dirs.length ) ] );
        await new Promise( res => setTimeout(res, 200) );
        return true;
    }
}

planLibrary.push( GoPickUp, GoDeliver, BfsMove, Explore );
