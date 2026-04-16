import { socket } from './connection.js';
import './plans.js'; // side-effect: registers all plan classes in planLibrary
import { me, mapBeliefs, parcels, deliveryTiles, spawnTiles } from './beliefs.js';
import { myAgent, optionsGeneration } from './agent.js';

// ─── Belief Revision ──────────────────────────────────────────────────────────

socket.onYou( ( {id, name, x, y, score} ) => {
    me.id    = id;
    me.name  = name;
    me.x     = x ?? me.x;
    me.y     = y ?? me.y;
    me.score = score;
} );

socket.on( 'map', async (width, height, tile) => {
    const tiles = Array.isArray(tile) ? tile : (tile || []);
    for ( const t of tiles ) {
        mapBeliefs.set( `${t.x}_${t.y}`, t );
        if ( t.type === '2' && !deliveryTiles.find( d => d.x === t.x && d.y === t.y ) )
            deliveryTiles.push( { x: t.x, y: t.y } );
        if ( t.type === '1' && !spawnTiles.find( s => s.x === t.x && s.y === t.y ) )
            spawnTiles.push( { x: t.x, y: t.y } );
    }
} );

socket.onTile( ( tile ) => {
    const { x, y, type } = tile;
    mapBeliefs.set( `${x}_${y}`, tile );
    if ( type === '2' && !deliveryTiles.find( t => t.x === x && t.y === y ) )
        deliveryTiles.push( { x, y } );
    if ( type === '1' && !spawnTiles.find( t => t.x === x && t.y === y ) )
        spawnTiles.push( { x, y } );
} );

socket.onSensing( ( sensing ) => {
    for ( const p of sensing.parcels )
        parcels.set( p.id, p );
    // Only remove parcels we don't carry; our own carried parcels may leave the FOV
    for ( const [id, p] of parcels )
        if ( !sensing.parcels.find( sp => sp.id === id ) && p.carriedBy !== me.id )
            parcels.delete( id );
} );

// ─── Options Generation ───────────────────────────────────────────────────────

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );
