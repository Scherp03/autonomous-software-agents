import { mapBeliefs } from './beliefs.js';

// ─── Utility ──────────────────────────────────────────────────────────────────

/** @type { function ({x:number,y:number},{x:number,y:number}):number } */
export function distance( {x:x1, y:y1}, {x:x2, y:y2} ) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) );
    const dy = Math.abs( Math.round(y1) - Math.round(y2) );
    return dx + dy;
}

// ─── Pathfinding (BFS) ────────────────────────────────────────────────────────

const DIRS = [
    { dir: 'right', dx:  1, dy:  0, blockedBy: '←' },
    { dir: 'left',  dx: -1, dy:  0, blockedBy: '→' },
    { dir: 'up',    dx:  0, dy:  1, blockedBy: '↓' },
    { dir: 'down',  dx:  0, dy: -1, blockedBy: '↑' },
];

/** Stores temporarily blocked tiles and their expiration timestamp */
export const temporaryBlocks = new Map();

function canEnter( nx, ny, blockedBy ) {
    const key = `${nx}_${ny}`;
    if ( temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now() ) return false;
    const tile = mapBeliefs.get( key );
    if ( !tile || tile.type === '0' ) return false;
    if ( tile.type === blockedBy ) return false;
    return true;
}

/**
 * Returns a list of direction strings to reach `to` from `from`, or null if unreachable.
 * Coordinates are rounded to integers to handle float positions during movement.
 * @param {{x:number, y:number}} from
 * @param {{x:number, y:number}} to
 * @returns {string[]|null}
 */
export function bfs( from, to ) {
    const startX  = Math.round(from.x);
    const startY  = Math.round(from.y);
    const targetX = Math.round(to.x);
    const targetY = Math.round(to.y);

    if ( startX === targetX && startY === targetY ) return [];

    const queue   = [ { x: startX, y: startY, path: [] } ];
    const visited = new Set( [ `${startX}_${startY}` ] );

    while ( queue.length > 0 ) {
        const { x, y, path } = queue.shift();

        for ( const { dir, dx, dy, blockedBy } of DIRS ) {
            const nx  = x + dx;
            const ny  = y + dy;
            const key = `${nx}_${ny}`;

            if ( visited.has(key) ) continue;
            if ( !canEnter(nx, ny, blockedBy) ) continue;

            const newPath = [ ...path, dir ];
            if ( nx === targetX && ny === targetY ) return newPath;

            visited.add( key );
            queue.push( { x: nx, y: ny, path: newPath } );
        }
    }

    return null;
}

/**
 * Returns the sequence of {x,y} tile positions visited when following `path` from `from`.
 * Used to check which tiles lie along a planned route (e.g., for opportunistic pickup).
 * @param {{x:number, y:number}} from
 * @param {string[]} path
 * @returns {{x:number, y:number}[]}
 */
export function getPathTiles( from, path ) {
    const deltas = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };
    const tiles  = [];
    let x = Math.round(from.x);
    let y = Math.round(from.y);

    for ( const dir of path ) {
        const [dx, dy] = deltas[dir];
        x += dx;
        y += dy;
        tiles.push( { x, y } );
    }

    return tiles;
}
