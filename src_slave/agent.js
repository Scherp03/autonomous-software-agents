import { planLibrary } from './plans.js';
import { me, parcels, deliveryTiles, gameConfig, dynamicRules } from './beliefs.js';
import { distance, parseMs } from './utils.js';
import { optionsGeneration } from './index.js'; 

export class IntentionRevision {

    /** @type {IntentionDeliberation[]} */
    #intention_queue = [];
    get intention_queue () { return this.#intention_queue; }

    #frozen = false;
    get frozen () { return this.#frozen; }

    freeze () {
        this.#frozen = true;
        if ( this.#intention_queue.length > 0 ) this.#intention_queue[0].stop();
        console.log( '[agent] Frozen.' );
    }

    unfreeze () {
        this.#frozen = false;
        console.log( '[agent] Unfrozen.' );
    }

    async loop () {
        while ( true ) {
            while ( this.#frozen ) {
                await new Promise( res => setTimeout( res, 200 ) );
            }

            if ( this.intention_queue.length > 0 ) {
                const intention = this.intention_queue[0];

                console.log( 'intentionRevision.loop', this.intention_queue.map(i=>i.predicate) );
                try {
                    await intention.achieve();
                } catch ( err ) {
                    console.log( 'Failed intention', ...intention.predicate, 'with error:', err )
                }

                if (this.intention_queue[0] == intention) {
                    this.intention_queue.shift();
                }
            } else {
                optionsGeneration();
                await new Promise( res => setImmediate( res ) );
            }
        }
    }

    /** @type { function(...any): void } */
    log ( ...args ) { console.log( ...args ); }

    /**
     * @abstract
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {}
}

export class IntentionRevisionRevise extends IntentionRevision {

    getUtility ( predicate ) {
        const [ action, x, y, id ] = predicate;
        const decayIntervalMs = parseMs( gameConfig.GAME.parcels.decaying_event );
        const decayPerStep    = gameConfig.CLOCK / decayIntervalMs;

        if ( action === 'go_to_bonus' ) {
            const rule = dynamicRules.edgeRules.get( id ) || dynamicRules.bonusTiles.get( `${x}_${y}` );
            if ( !rule || rule.pts <= 0 ) return -1;
            return rule.pts - distance( me, { x, y } ) * decayPerStep;
        }

        if ( action === 'drop_on_tile' ) {
            const rule = dynamicRules.edgeRules.get( id ) || dynamicRules.bonusTiles.get( `${x}_${y}` );
            if ( !rule || rule.pts <= 0 ) return -1;
            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
            if ( carried.length === 0 ) return -1;
            return ( rule.pts * carried.length ) - distance( me, { x, y } ) * decayPerStep;
        }

        if ( action === 'go_deliver' ) {
            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
            if ( carried.length === 0 ) return -1;

            const isTooHigh = carried.some( p => p.reward > dynamicRules.parcelMaxReward );
            if ( isTooHigh ) return -1;

            const dist = distance( me, { x, y } );
            let partialUtility = carried.reduce( (sum, p) => sum + Math.max( 0, p.reward - dist * decayPerStep ), 0 );

            if ( dynamicRules.stackSizeRule ) {
                const { size, multiplier } = dynamicRules.stackSizeRule;
                if ( multiplier >= 1 ) {
                    if ( carried.length === size ) partialUtility *= multiplier;
                    else if ( carried.length < size ) return -1;
                } else {
                    if ( carried.length === size ) partialUtility *= multiplier;
                }
            }

            const key = `${x}_${y}`;
            if ( dynamicRules.deliveryMultipliers.has( key ) )
                partialUtility *= dynamicRules.deliveryMultipliers.get( key );

            if ( partialUtility < 1 ) return -1;
            return partialUtility + gameConfig.GAME.parcels.reward_variance / 2;
        }

        if ( action === 'go_pick_up' ) {
            const parcel = parcels.get( id );
            if ( !parcel || parcel.carriedBy ) return -1;
            if ( parcel.reward > dynamicRules.parcelMaxReward ) return -1;

            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );

            if ( dynamicRules.stackSizeRule ) {
                if ( carried.length >= dynamicRules.stackSizeRule.size ) return -1;
            }

            const nearestDel = deliveryTiles.reduce( (best, t) => {
                const d = distance( { x, y }, t );
                return d < best.d ? { t, d } : best;
            }, { t: null, d: Infinity } );
            if ( !nearestDel.t ) return -1;

            const totalSteps = distance( me, { x, y } ) + nearestDel.d;
            const revisedUtility = [ ...carried, parcel ].reduce(
                (sum, p) => sum + Math.max( 0, p.reward - totalSteps * decayPerStep ), 0 );

            if ( revisedUtility < 1 ) return -1;
            return revisedUtility;
        }

        if ( action === 'go_to_matching_tile' ) return predicate[2] ?? 500;
        if ( action === 'go_to_neighborhood' ) return predicate[2] ?? 500;
        if ( action === 'go_to_edge' ) return x ?? 500;
        if ( action === 'handoff_slave' ) return 9999;

        if ( action === 'explore' ) return 0;

        return -1;
    }

    async push ( predicate ) {
        if ( this.frozen ) return;

        // 1. Validate
        const utility = this.getUtility( predicate );
        if ( utility < 0 ) return;

        // At most one go_deliver in queue; replace if destination changed.
        if ( predicate[0] === 'go_deliver' ) {
            const existingIdx = this.intention_queue.findIndex( i => i.predicate[0] === 'go_deliver' );
            if ( existingIdx !== -1 ) {
                const existing = this.intention_queue[ existingIdx ];
                if ( existing.predicate.join(' ') === predicate.join(' ') ) return;
                existing.stop();
                this.intention_queue.splice( existingIdx, 1 );
            }
        } else {
            // For all other actions, skip exact duplicates
            const isDuplicate = this.intention_queue.some(
                i => i.predicate.join(' ') === predicate.join(' ')
            );
            if ( isDuplicate ) return;
        }

        const newIntention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( newIntention );
        const currentTop = this.intention_queue[0];

        // 2. Sort by utility (highest first)
        this.intention_queue.sort( ( a, b ) => {
            return this.getUtility( b.predicate ) - this.getUtility( a.predicate );
        } );

        // 3. Preempt current if outranked
        const newTop = this.intention_queue[0];
        if ( currentTop && currentTop !== newTop && !currentTop.stopped ) {
            currentTop.stop();
            const index = this.intention_queue.indexOf( currentTop );
            if ( index > -1 ) this.intention_queue.splice( index, 1 );
        }

        // 4. Prune invalid intentions (e.g. parcels picked up opportunistically)
        for ( let i = this.intention_queue.length - 1; i >= 0; i-- ) {
            if ( this.getUtility( this.intention_queue[ i ].predicate ) < 0 ) {
                this.intention_queue[ i ].stop();
                this.intention_queue.splice( i, 1 );
            }
        }
    }

    // Insert at front bypassing utility scoring; yields to a running handoff.
    pushUrgent ( predicate ) {
        const currentIsHandoff = this.intention_queue.length > 0 &&
            this.intention_queue[ 0 ].predicate[ 0 ] === 'handoff_slave';

        if ( !currentIsHandoff && this.intention_queue.length > 0 ) {
            this.intention_queue[ 0 ].stop();
            this.intention_queue.splice( 0, 1 );
        }

        for ( let i = this.intention_queue.length - 1; i >= 0; i-- ) {
            if ( [ 'go_to_neighborhood', 'go_to_matching_tile', 'go_to_edge' ].includes( this.intention_queue[ i ].predicate[ 0 ] ) ) {
                this.intention_queue[ i ].stop();
                this.intention_queue.splice( i, 1 );
            }
        }

        const newIntention = new IntentionDeliberation( this, predicate );
        if ( currentIsHandoff ) {
            this.intention_queue.splice( 1, 0, newIntention );
        } else {
            this.intention_queue.unshift( newIntention );
        }
    }
}

/**
 * @typedef { {
 *      stop: ()=>void,
 *      stopped: boolean,
 *      log: (...arg0: any[])=>void,
 *      subIntention: (predicate: any) => Promise<any>,
 *      execute: function (string, ...any) : Promise<boolean>
 * } } Plan
 */

export class IntentionDeliberation {

    /** @type { Plan | undefined } */
    #current_plan;

    #stopped = false;
    get stopped () { return this.#stopped; }

    stop () {
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    #parent;

    /** @type { [string, ...any] } */
    #predicate;
    get predicate () { return this.#predicate; }

    /**
     * @param { IntentionDeliberation } parent
     * @param { [string, ...any] } predicate
     */
    constructor ( parent, predicate ) {
        this.#parent    = parent;
        this.#predicate = predicate;
    }

    /** @type { function(...any): void } */
    log ( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    #started = false;

    async achieve () {
        if ( this.#started ) return false;
        this.#started = true;

        for ( const planClass of planLibrary ) {
            if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                this.#current_plan = new planClass( this.#parent );
                try {
                    const res = await this.#current_plan?.execute( ...this.predicate );
                    return res || false;
                } catch ( error ) {
                    this.log( 'failed', ...this.predicate, 'error:', error );
                }
            }
        }

        if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
        throw [ 'no plan satisfied', ...this.predicate ];
    }
}