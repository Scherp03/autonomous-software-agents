import { socket } from './socket.js';
import { me, mapBeliefs, deliveryTiles, spawnTiles, spawnWeights, agents, parcels, gameConfig, dynamicRules, mapWidthxHeight, CAPACITY, temporaryBlocks, failureCounters } from './beliefs.js';
import { distance } from './utils.js';
import { IntentionRevisionRevise } from './agent.js';
import { GoPickUp, GoDeliver, AStarMove, Explore, planLibrary, GoToBonus, DropOnTile, GoToMatchingTile, GoToNeighborhood, HandoffLLM, GoToEdge } from './plans.js';

import { setSelfAgent } from './llm.js';

// ─── Belief Revision (Socket Listeners) ──────────────────────────────────────
socket.onConfig( config => {
    gameConfig.CLOCK          = config.CLOCK          ?? gameConfig.CLOCK;
    gameConfig.PENALTY        = config.PENALTY        ?? gameConfig.PENALTY;
    gameConfig.AGENT_TIMEOUT  = config.AGENT_TIMEOUT  ?? gameConfig.AGENT_TIMEOUT;
    gameConfig.BROADCAST_LOGS = config.BROADCAST_LOGS ?? gameConfig.BROADCAST_LOGS;
    if ( config.GAME ) {
        const g = config.GAME;
        if ( g.title       !== undefined ) gameConfig.GAME.title       = g.title;
        if ( g.description !== undefined ) gameConfig.GAME.description = g.description;
        if ( g.maxPlayers  !== undefined ) gameConfig.GAME.maxPlayers  = g.maxPlayers;
        if ( g.map         !== undefined ) Object.assign( gameConfig.GAME.map,     g.map     );
        if ( g.parcels     !== undefined ) Object.assign( gameConfig.GAME.parcels, g.parcels );
        if ( g.player      !== undefined ) Object.assign( gameConfig.GAME.player,  g.player  );
    }
    // Log config without map layout for readability
    const configWithoutMap = {...gameConfig};
    delete configWithoutMap.GAME.map;
    console.log( '[config]', JSON.stringify( configWithoutMap, null, 2 ) );
} );

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id    = id;
    me.name  = name;
    me.x     = x ?? me.x;
    me.y     = y ?? me.y;
    me.score = score;

    const key = `${me.x}_${me.y}`;
    const cx = Math.round(me.x);
    const cy = Math.round(me.y);

    if (failureCounters.has(key)) failureCounters.set(key, 0);

    // Consume bonus tile the moment we step on it
    if (dynamicRules.bonusTiles.has(key) && !dynamicRules.bonusTiles.get(key).mustDrop) {
        dynamicRules.bonusTiles.delete(key);
        console.log(`[Bonus] Walked through bonus tile ${key}! Bonus cleared.`);
    }

    // Clear edge rules for the border we just reached
    const borders = [];
    if (cx == mapWidthxHeight.minX) borders.push('left');
    if (cx == mapWidthxHeight.x)    borders.push('right');
    if (cy == mapWidthxHeight.minY) borders.push('bottom');
    if (cy == mapWidthxHeight.y)    borders.push('top');

    for (const b of borders) {
        if (dynamicRules.edgeRules.has(b) && !dynamicRules.edgeRules.get(b).mustDrop) {
            dynamicRules.edgeRules.delete(b);
        }
    }
} );

function updateTileBelief( x, y, type ) {
    const t = type.toString();

    const delIdx = deliveryTiles.findIndex( d => d.x == x && d.y == y );
    if ( t == '2' ) { if ( delIdx === -1 ) deliveryTiles.push( {x, y} ); }
    else            { if ( delIdx !== -1 ) deliveryTiles.splice( delIdx, 1 ); }

    const spawnIdx = spawnTiles.findIndex( s => s.x == x && s.y == y );
    if ( t == '1' ) { if ( spawnIdx === -1 ) spawnTiles.push( {x, y} ); }
    else            { if ( spawnIdx !== -1 ) spawnTiles.splice( spawnIdx, 1 ); }
}

// Gaussian KDE over spawn tiles. Bandwidth = observation_distance.
// Tiles in dense spawn clusters get higher weight; isolated tiles get lower weight.
// Falls back to uniform weights when spawn tiles cover >= 1/3 of the map.
function recomputeSpawnWeights() {
    spawnWeights.clear();
    const n = spawnTiles.length;
    if ( n === 0 ) return;

    if ( n >= mapBeliefs.size / 3 ) {
        for ( const t of spawnTiles ) spawnWeights.set( `${t.x}_${t.y}`, 1 );
        return;
    }

    const h     = gameConfig.GAME.player.observation_distance;
    const twoH2 = 2 * h * h;

    for ( const si of spawnTiles ) {
        let w = 0;
        for ( const sj of spawnTiles ) {
            const dx = si.x - sj.x;
            const dy = si.y - sj.y;
            w += Math.exp( -(dx * dx + dy * dy) / twoH2 );
        }
        spawnWeights.set( `${si.x}_${si.y}`, w );
    }
}

socket.onMap( (width, height, tile) => {
const tiles = Array.isArray(tile) ? tile : (tile || []);

    let maxX = -1;
    let maxY = -1;
    let minX = Infinity;
    let minY = Infinity;

    for ( const t of tiles ) {
        mapBeliefs.set( `${t.x}_${t.y}`, t );
        updateTileBelief( t.x, t.y, t.type );

        if (t.type !== '0') {
            if (t.x > maxX) maxX = t.x;
            if (t.y > maxY) maxY = t.y;
            if (t.x < minX) minX = t.x;
            if (t.y < minY) minY = t.y;
        }
    }

    mapWidthxHeight.x    = maxX;
    mapWidthxHeight.y    = maxY;
    mapWidthxHeight.minX = minX;
    mapWidthxHeight.minY = minY;

    console.log( `[map] Received map of size ${width}x${height}. True walkable bounds: X(${minX} to ${maxX}), Y(${minY} to ${maxY})` );
    recomputeSpawnWeights();
});

socket.onTile( ( tile ) => {
    const {x, y, type} = tile;
    mapBeliefs.set( `${x}_${y}`, tile );
    updateTileBelief( x, y, type );
    recomputeSpawnWeights();
} );

socket.onSensing( ( sensing ) => {
    for ( const p of sensing.parcels ) parcels.set( p.id, p );
    for ( const [id] of parcels ) {
        if ( !sensing.parcels.find( p => p.id == id ) ) parcels.delete( id );
    }
    for ( const a of sensing.agents ) agents.set( a.id, a );
    for ( const [id] of agents ) {
        if ( !sensing.agents.find( a => a.id == id ) ) agents.delete( id );
    }
} );

// ─── Options Generation ──────────────────────────────────────────────────────

export function optionsGeneration () {
    const carried   = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
    const available = Array.from( parcels.values() ).filter( p =>
        !p.carriedBy && p.reward > gameConfig.GAME.parcels.reward_variance
    );

    // Generate individual tile bonus tasks
    for (const [key, rule] of dynamicRules.bonusTiles.entries()) {
        const [bx, by] = key.split('_').map(Number);

        const tile = mapBeliefs.get(`${bx}_${by}`);
        if (!tile || tile.type === '0') {
            console.log(`[Warning] Tile ${bx},${by} is a wall. Deleting impossible rule.`);
            dynamicRules.bonusTiles.delete(key);
            continue;
        }

        const isForbidden   = dynamicRules.forbiddenTiles.has(key);
        const isTempBlocked = temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now();

        if (!isForbidden && !isTempBlocked) {
            if (rule.mustDrop && carried.length > 0) {
                myAgent.push(['drop_on_tile', bx, by]);
            } else if (!rule.mustDrop) {
                myAgent.push(['go_to_bonus', bx, by]);
            }
        }
    }

    // Generate border tasks
    for (const [edge, rule] of dynamicRules.edgeRules.entries()) {
        if (rule.pts > 0) {
            const walkableEdgeTiles = Array.from(mapBeliefs.values()).filter(t => {
                if (t.type == '0') return false;
                if (edge == 'left'   && t.x == mapWidthxHeight.minX) return true;
                if (edge == 'right'  && t.x == mapWidthxHeight.x)    return true;
                if (edge == 'bottom' && t.y == mapWidthxHeight.minY) return true;
                if (edge == 'top'    && t.y == mapWidthxHeight.y)    return true;
                return false;
            });

            if (walkableEdgeTiles.length > 0) {
                const target = walkableEdgeTiles
                    .filter( t => {
                        const key = `${t.x}_${t.y}`;
                        return !dynamicRules.forbiddenTiles.has(key) &&
                               !(temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now());
                    })
                    .reduce((best, t) => {
                        const d = distance(me, t);
                        return d < best.d ? { t, d } : best;
                    }, { t: null, d: Infinity }).t;

                if (target) {
                    if (rule.mustDrop && carried.length > 0) {
                        myAgent.push(['drop_on_tile', target.x, target.y, edge]);
                    } else if (!rule.mustDrop) {
                        myAgent.push(['go_to_bonus', target.x, target.y, edge]);
                    }
                }
            }
        }
    }

    // Propose delivery to the nearest non-blocked tile
    if ( carried.length > 0 && deliveryTiles.length > 0 ) {
        // Delay delivery if building a bonus stack and not yet at target size
        const isBonus = dynamicRules.stackSizeRule && dynamicRules.stackSizeRule.multiplier > 1;
        if (!isBonus || carried.length >= dynamicRules.stackSizeRule.size ) {
            const nearestDelivery = deliveryTiles
            .filter( t => {
                const key = `${t.x}_${t.y}`;
                return !dynamicRules.forbiddenTiles.has(key) &&
                       !(temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now());
            })
            .reduce( (best, t) => {
                const u = myAgent.getUtility(['go_deliver', t.x, t.y]);
                const d = distance( me, t );
                // Pick tile with higher utility; break ties by distance
                if ( u > best.u || (u === best.u && d < best.d) ) return { t, u, d };
                return best;
            }, { t: null, u: -Infinity, d: Infinity } ).t;
            if ( nearestDelivery ) {
                myAgent.push( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );
            }
        }
    }

    // Propose each available parcel unless at capacity or a closer agent exists
    if ( carried.length < CAPACITY ) {
        for ( const p of available ) {
            const key = `${Math.round(p.x)}_${Math.round(p.y)}`;
            if (temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now()) continue;

            const closerAgentExists = Array.from( agents.values() ).some(
                a => distance( a, p ) < distance( me, p )
            );
            if ( !closerAgentExists ) {
                myAgent.push( [ 'go_pick_up', p.x, p.y, p.id ] );
            }
        }
    }

    // Explore as lowest-priority fallback
    myAgent.push( [ 'explore' ] );
}

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );

const myAgent = new IntentionRevisionRevise();

setSelfAgent( myAgent );

myAgent.loop();

planLibrary.push( HandoffLLM );
planLibrary.push( GoToEdge );
planLibrary.push( GoToMatchingTile );
planLibrary.push( GoToNeighborhood );
planLibrary.push( GoToBonus );
planLibrary.push( DropOnTile );
planLibrary.push( GoPickUp );
planLibrary.push( GoDeliver );
planLibrary.push( AStarMove );
planLibrary.push( Explore );
