/**
 * Manhattan distance between two points
 * @type { function ({x:number,y:number},{x:number,y:number}):number }
 */
export function distance( {x:x1, y:y1}, {x:x2, y:y2} ) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) );
    const dy = Math.abs( Math.round(y1) - Math.round(y2) );
    return dx + dy;
}

/**
 * Parse a server interval string ('1s', '500ms') into milliseconds.
 * @param { string } str
 * @returns { number }
 */
export function parseMs( str ) {
    const m = str.match( /^(\d+(?:\.\d+)?)(ms|s)$/ );
    if ( !m ) return 1000;
    return parseFloat( m[1] ) * ( m[2] === 's' ? 1000 : 1 );
}

/**
 * Weighted random selection. Falls back to uniform if all weights are zero.
 * @param { any[] } items
 * @param { number[] } weights  same length as items, all >= 0
 * @returns { any }
 */
export function weightedRandom( items, weights ) {
    const total = weights.reduce( (s, w) => s + w, 0 );
    if ( total === 0 ) return items[ Math.floor( Math.random() * items.length ) ];
    let r = Math.random() * total;
    for ( let i = 0; i < items.length; i++ ) {
        r -= weights[ i ];
        if ( r <= 0 ) return items[ i ];
    }
    return items[ items.length - 1 ];
}