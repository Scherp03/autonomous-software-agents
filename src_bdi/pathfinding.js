import { mapBeliefs, temporaryBlocks } from './beliefs.js';

const DIRS = [
    { dir: 'right', dx:  1, dy:  0, blockedBy: '←' },
    { dir: 'left',  dx: -1, dy:  0, blockedBy: '→' },
    { dir: 'up',    dx:  0, dy:  1, blockedBy: '↓' },
    { dir: 'down',  dx:  0, dy: -1, blockedBy: '↑' },
];

export function canEnter( nx, ny, blockedBy ) {
    const key = `${nx}_${ny}`;

    if ( temporaryBlocks.has(key) && temporaryBlocks.get(key) > Date.now() ) {
        return false;
    }

    const tile = mapBeliefs.get( key );
    if ( !tile || tile.type == '0' ) return false;
    if ( tile.type == blockedBy ) return false;
    return true;
}

class MinHeap {
    #heap = [];

    get size() { return this.#heap.length; }

    push( item ) {
        this.#heap.push( item );
        this.#bubbleUp( this.#heap.length - 1 );
    }

    pop() {
        const top  = this.#heap[ 0 ];
        const last = this.#heap.pop();
        if ( this.#heap.length > 0 ) {
            this.#heap[ 0 ] = last;
            this.#sinkDown( 0 );
        }
        return top;
    }

    #bubbleUp( i ) {
        while ( i > 0 ) {
            const parent = ( i - 1 ) >> 1;
            if ( this.#heap[ parent ].f <= this.#heap[ i ].f ) break;
            [ this.#heap[ parent ], this.#heap[ i ] ] = [ this.#heap[ i ], this.#heap[ parent ] ];
            i = parent;
        }
    }

    #sinkDown( i ) {
        const n = this.#heap.length;
        while ( true ) {
            let smallest = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if ( l < n && this.#heap[ l ].f < this.#heap[ smallest ].f ) smallest = l;
            if ( r < n && this.#heap[ r ].f < this.#heap[ smallest ].f ) smallest = r;
            if ( smallest === i ) break;
            [ this.#heap[ smallest ], this.#heap[ i ] ] = [ this.#heap[ i ], this.#heap[ smallest ] ];
            i = smallest;
        }
    }
}

// Returns the shortest path as an array of direction strings, or null if unreachable.
export function astar( from, to ) {
    const startX  = Math.round( from.x );
    const startY  = Math.round( from.y );
    const targetX = Math.round( to.x );
    const targetY = Math.round( to.y );

    if ( startX === targetX && startY === targetY ) return [];

    const h = ( x, y ) => Math.abs( x - targetX ) + Math.abs( y - targetY );

    const open = new MinHeap();
    open.push( { x: startX, y: startY, g: 0, f: h( startX, startY ), path: [] } );

    const gScore = new Map( [ [ `${startX}_${startY}`, 0 ] ] );

    while ( open.size > 0 ) {
        const { x, y, g, path } = open.pop();

        if ( x === targetX && y === targetY ) return path;

        for ( const { dir, dx, dy, blockedBy } of DIRS ) {
            const nx  = x + dx;
            const ny  = y + dy;
            const key = `${nx}_${ny}`;

            if ( !canEnter( nx, ny, blockedBy ) ) continue;

            const ng = g + 1;
            if ( gScore.has( key ) && gScore.get( key ) <= ng ) continue;

            gScore.set( key, ng );
            open.push( { x: nx, y: ny, g: ng, f: ng + h( nx, ny ), path: [ ...path, dir ] } );
        }
    }

    return null;
}

// Distance-only variant: skips building path arrays, used for scoring.
export function astarDistance( from, to ) {
    const startX  = Math.round( from.x );
    const startY  = Math.round( from.y );
    const targetX = Math.round( to.x );
    const targetY = Math.round( to.y );

    if ( startX === targetX && startY === targetY ) return 0;

    const h = ( x, y ) => Math.abs( x - targetX ) + Math.abs( y - targetY );

    const open = new MinHeap();
    open.push( { x: startX, y: startY, g: 0, f: h( startX, startY ) } );

    const gScore = new Map( [ [ `${startX}_${startY}`, 0 ] ] );

    while ( open.size > 0 ) {
        const { x, y, g } = open.pop();

        if ( x === targetX && y === targetY ) return g;

        for ( const { dir, dx, dy, blockedBy } of DIRS ) {
            const nx  = x + dx;
            const ny  = y + dy;
            const key = `${nx}_${ny}`;

            if ( !canEnter( nx, ny, blockedBy ) ) continue;

            const ng = g + 1;
            if ( gScore.has( key ) && gScore.get( key ) <= ng ) continue;

            gScore.set( key, ng );
            open.push( { x: nx, y: ny, g: ng, f: ng + h( nx, ny ) } );
        }
    }

    return Infinity;
}
