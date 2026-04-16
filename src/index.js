import { socket } from './socket.js';
import { me, mapBeliefs, deliveryTiles, spawnTiles, parcels } from './beliefs.js';
import { distance } from './utils.js';
import { IntentionRevisionReplace } from './agent.js';
import { GoPickUp, GoDeliver, BfsMove, Explore, planLibrary } from './plans.js';

// ─── Belief Revision (Socket Listeners) ──────────────────────────────────────
socket.onYou( ( {id, name, x, y, score} ) => {
    me.id    = id;
    me.name  = name;
    me.x     = x ?? me.x;
    me.y     = y ?? me.y;
    me.score = score;
} );

socket.onMap( (width, height, tile)  => {
    const tiles = Array.isArray(tile) ? tile : (tile || []);
    for ( const tile of tiles ) {
        mapBeliefs.set( `${tile.x}_${tile.y}`, tile );
        
        if ( tile.type === '2' && !deliveryTiles.find( t => t.x === tile.x && t.y === tile.y ) ) {
            deliveryTiles.push( {x: tile.x, y: tile.y} );
        }
        if ( tile.type === '1' && !spawnTiles.find( t => t.x === tile.x && t.y === tile.y ) ) {
            spawnTiles.push( {x: tile.x, y: tile.y} );
        }
    }
});

socket.onTile( ( tile ) => {
    const {x, y, type} = tile;
    mapBeliefs.set( `${x}_${y}`, tile );
    
    if ( type === '2' && !deliveryTiles.find( t => t.x === x && t.y === y ) ) {
        deliveryTiles.push( {x, y} );
    }
    if ( type === '1' && !spawnTiles.find( t => t.x === x && t.y === y ) ) {
        spawnTiles.push( {x, y} );
    }
} );

socket.onSensing( ( sensing ) => {
    for ( const p of sensing.parcels ) parcels.set( p.id, p );
    for ( const [id] of parcels ) {
        if ( !sensing.parcels.find( p => p.id === id ) ) parcels.delete( id );
    }
} );

// ─── Options Generation ──────────────────────────────────────────────────────
function optionsGeneration () {
    if ( !me.id ) return;

    const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
    const available = Array.from( parcels.values() ).filter( p => !p.carriedBy && p.reward > 10 );

    let bestPickUp = null;
    if ( available.length > 0 ) {
        bestPickUp = [ ...available ].sort( (a, b) => {
            const scoreA = a.reward / ( distance(me, a) + 1 );
            const scoreB = b.reward / ( distance(me, b) + 1 );
            if (scoreB !== scoreA) return scoreB - scoreA;
            return a.id.localeCompare(b.id); 
        })[ 0 ];
    }

    if ( carried.length > 0 && deliveryTiles.length > 0 ) {
        const nearestDelivery = [ ...deliveryTiles ].sort( (a, b) => {
            const distDiff = distance(me, a) - distance(me, b);
            if (distDiff !== 0) return distDiff;
            return a.x - b.x; 
        })[ 0 ];

        if ( bestPickUp && distance(me, bestPickUp) <= 2 ) {
            myAgent.push( [ 'go_pick_up', bestPickUp.x, bestPickUp.y, bestPickUp.id ] );
            return;
        }

        myAgent.push( [ 'go_deliver', nearestDelivery.x, nearestDelivery.y ] );
        return; 
    }
    
    if ( bestPickUp ) {
        myAgent.push( [ 'go_pick_up', bestPickUp.x, bestPickUp.y, bestPickUp.id ] );
        return;
    }

    myAgent.push( [ 'explore' ] );
}

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );

const myAgent = new IntentionRevisionReplace();
myAgent.loop();

planLibrary.push( GoPickUp );
planLibrary.push( GoDeliver );
planLibrary.push( BfsMove );
planLibrary.push( Explore );