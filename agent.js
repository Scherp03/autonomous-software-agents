import { me, parcels, deliveryTiles } from './beliefs.js';
import { distance, bfs, getPathTiles } from './pathfinding.js';
import { IntentionRevisionReplace } from './intentions.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Minimum carried-parcel reward before the agent drops everything and delivers immediately */
const URGENT_REWARD_THRESHOLD = 15;

/** Maximum distance from any path tile for an opportunistic pickup to be triggered */
const OPPORTUNISTIC_MAX_DIST = 3;

// ─── Agent Instance ───────────────────────────────────────────────────────────

export const myAgent = new IntentionRevisionReplace();
myAgent.loop();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the tile in `tiles` nearest to `from` (Manhattan distance, x as tie-breaker).
 * @param {{x:number, y:number}} from
 * @param {{x:number, y:number}[]} tiles
 * @returns {{x:number, y:number}}
 */
function nearestTile( from, tiles ) {
    return [ ...tiles ].sort( (a, b) => {
        const diff = distance(from, a) - distance(from, b);
        return diff !== 0 ? diff : a.x - b.x;
    } )[0];
}

// ─── Autonomous re-evaluation ─────────────────────────────────────────────────
// Re-evaluate options every 500 ms so the agent never idles between sensor events.
setInterval( optionsGeneration, 500 );

// ─── Options Generation ───────────────────────────────────────────────────────

export function optionsGeneration() {
    if ( !me.id ) return;

    const carried   = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
    const available = Array.from( parcels.values() ).filter( p => !p.carriedBy );

    // ── Priority 1: Urgent delivery ───────────────────────────────────────────
    // If any carried parcel is close to expiring, go straight to delivery; no detours.
    if ( carried.length > 0 && deliveryTiles.length > 0 ) {
        const minReward = Math.min( ...carried.map( p => p.reward ) );

        if ( minReward < URGENT_REWARD_THRESHOLD ) {
            const target = nearestTile( me, deliveryTiles );
            myAgent.push( [ 'go_deliver', target.x, target.y ] );
            return;
        }

        // ── Priority 2: Opportunistic pickup while delivering ─────────────────
        // All carried parcels are safe (>= threshold). If a free parcel lies within
        // OPPORTUNISTIC_MAX_DIST tiles of any node on our planned delivery path, detour.
        const nearestDelivery = nearestTile( me, deliveryTiles );
        const pathToDelivery  = bfs( me, nearestDelivery );

        if ( pathToDelivery && available.length > 0 ) {
            const pathTiles      = getPathTiles( me, pathToDelivery );
            const opportunistic  = available
                .filter( p => pathTiles.some( t => distance(t, p) <= OPPORTUNISTIC_MAX_DIST ) )
                .sort( (a, b) => distance(me, a) - distance(me, b) )[0];

            if ( opportunistic ) {
                myAgent.push( [ 'go_pick_up', opportunistic.x, opportunistic.y, opportunistic.id ] );
                return;
            }
        }

        myAgent.push( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );
        return;
    }

    // ── Priority 3: Target sensed parcel ──────────────────────────────────────
    // Score = reward / (distance + 1); tie-break by id for stability.
    if ( available.length > 0 ) {
        const best = [ ...available ].sort( (a, b) => {
            const scoreA = a.reward / ( distance(me, a) + 1 );
            const scoreB = b.reward / ( distance(me, b) + 1 );
            if ( scoreB !== scoreA ) return scoreB - scoreA;
            return a.id.localeCompare( b.id );
        } )[0];

        myAgent.push( [ 'go_pick_up', best.x, best.y, best.id ] );
        return;
    }

    // ── Priority 4: Explore ───────────────────────────────────────────────────
    myAgent.push( [ 'explore' ] );
}
