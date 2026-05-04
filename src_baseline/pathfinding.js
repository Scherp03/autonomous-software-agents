import { mapBeliefs, temporaryBlocks } from './beliefs.js';

const DIRS = [
    { dir: 'right', dx:  1, dy:  0, blockedBy: '←' },
    { dir: 'left',  dx: -1, dy:  0, blockedBy: '→' },
    { dir: 'up',    dx:  0, dy:  1, blockedBy: '↓' },
    { dir: 'down',  dx:  0, dy: -1, blockedBy: '↑' },
];

export function canEnter( nx, ny, blockedBy ) {
    const key = `${nx}_${ny}`;
    
    // Check if this tile was recently blocked by a failed move
    if ( temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now() ) {
        return false; 
    }

    const tile = mapBeliefs.get( key );
    if ( !tile || tile.type == '0' ) return false;
    if ( tile.type == blockedBy ) return false;
    return true;
}

export function bfs( from, to ) {
    const startX = Math.round(from.x);
    const startY = Math.round(from.y);
    const targetX = Math.round(to.x);
    const targetY = Math.round(to.y);

    if ( startX == targetX && startY == targetY ) return [];

    const queue   = [ { x: startX, y: startY, path: [] } ];
    const visited = new Set( [ `${startX}_${startY}` ] );

    while ( queue.length > 0 ) {
        const { x, y, path } = queue.shift();

        for ( const { dir, dx, dy, blockedBy } of DIRS ) {
            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx}_${ny}`;
            
            if ( visited.has(key) ) continue;
            if ( !canEnter(nx, ny, blockedBy) ) continue;

            const newPath = [ ...path, dir ];
            if ( nx == targetX && ny == targetY ) return newPath;

            visited.add( key );
            queue.push( { x: nx, y: ny, path: newPath } );
        }
    }

    return null; 
}