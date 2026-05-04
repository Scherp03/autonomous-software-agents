import { socket } from './socket.js';
import { me, mapBeliefs, deliveryTiles, spawnTiles, spawnWeights, agents, parcels, gameConfig } from './beliefs.js';
import { distance } from './utils.js';
import { IntentionRevisionRevise } from './agent.js';
import { GoPickUp, GoDeliver, BfsMove, Explore, planLibrary } from './plans.js';

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
    console.log( '[config]', JSON.stringify( gameConfig, null, 2 ) );
} );

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id    = id;
    me.name  = name;
    me.x     = x ?? me.x;
    me.y     = y ?? me.y;
    me.score = score;
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
    for ( const tile of tiles ) {
        mapBeliefs.set( `${tile.x}_${tile.y}`, tile );
        updateTileBelief( tile.x, tile.y, tile.type );
    }
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

    // Propose delivery to the nearest tile if carrying anything
    if ( carried.length > 0 && deliveryTiles.length > 0 ) {
        const nearestDelivery = deliveryTiles.reduce( (best, t) => {
            const d = distance( me, t );
            return d < best.d ? { t, d } : best;
        }, { t: null, d: Infinity } ).t;
        if ( nearestDelivery ) {
            myAgent.push( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );
        }
    }

    // Propose each available parcel as a pickup, unless already at capacity
    // or another visible agent is strictly closer to that parcel
    if ( carried.length < gameConfig.GAME.player.capacity ) {
        for ( const p of available ) {
            const closerAgentExists = Array.from( agents.values() ).some(
                a => distance( a, p ) < distance( me, p )
            );
            if ( !closerAgentExists ) {
                myAgent.push( [ 'go_pick_up', p.x, p.y, p.id ] );
            }
        }
    }

    // Always propose explore as fallback; getUtility ranks it last (utility = 0)
    myAgent.push( [ 'explore' ] );
}

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );

// const myAgent = new IntentionRevisionReplace();
const myAgent = new IntentionRevisionRevise();

myAgent.loop();

planLibrary.push( GoPickUp );
planLibrary.push( GoDeliver );
planLibrary.push( BfsMove );
planLibrary.push( Explore );