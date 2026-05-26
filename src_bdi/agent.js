import { planLibrary } from './plans.js';
import { me, parcels, deliveryTiles, gameConfig } from './beliefs.js';
import { distance, parseMs } from './utils.js';
import { optionsGeneration } from './index.js'; 

export class IntentionRevision {
    
    /** @type {IntentionDeliberation[]} */
    #intention_queue = [];
    get intention_queue () { return this.#intention_queue; }

    async loop () {
        while ( true ) {
            if ( this.intention_queue.length > 0 ) {
                const intention = this.intention_queue[0];

                console.log( 'intentionRevision.loop', this.intention_queue.map(i=>i.predicate) );
                // Execution wrapped safely. 
                // Plans should validate their own targets before/during execution.
                try {
                    await intention.achieve();
                } catch ( err ) {
                    // Swallow expected plan failures or 'stopped' signals
                    console.log( 'Failed intention', ...intention.predicate, 'with error:', err )
                }

                // Only shift if the intention we just finished is still at index 0.
                // (In case a 'Replace' cleared the array while we were yielding)
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

    /**
     * Helper method to evaluate the validity and utility of an intention.
     * Utility is calculated as: Reward - Cost (distance).
     * Returns -1 if the intention is invalid.
     */
    getUtility ( predicate ) {
        const [ action, x, y, id ] = predicate;
        const decayIntervalMs = parseMs( gameConfig.GAME.parcels.decaying_event );
        const decayPerStep    = gameConfig.CLOCK / decayIntervalMs;

        if ( action === 'go_deliver' ) {
            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );
            if ( carried.length === 0 ) return -1;
            const dist = distance( me, { x, y } );

            // sum of utilities of all parcels being delivered, where utility of each parcel is max(0, reward - decayPerStep * dist)
            const partialUtility = carried.reduce( (sum, p) => sum + Math.max(0, p.reward - dist * decayPerStep), 0 );

            if ( partialUtility < 1 ) return -1; // If all parcels would have 0 or negative utility, skip delivery

            return partialUtility + gameConfig.GAME.parcels.reward_variance / 2;
        }

        if ( action === 'go_pick_up' ) {
            const parcel = parcels.get( id );
            if ( !parcel || parcel.carriedBy ) return -1;

            const carried = Array.from( parcels.values() ).filter( p => p.carriedBy === me.id );

            // Nearest delivery tile from the pickup spot (Manhattan)
            const nearestDel = deliveryTiles.reduce( (best, t) => {
                const d = distance( { x, y }, t );
                return d < best.d ? { t, d } : best;
            }, { t: null, d: Infinity } );
            if ( !nearestDel.t ) return -1;

            // All parcels (carried + new) decay for the full trip: me→parcel→delivery
            const totalSteps = distance( me, { x, y } ) + nearestDel.d;

            // Utility of the new parcel is its reward minus decay over the full trip, 
            // and utility of carried parcels also decays more while detouring for the pickup. 
            // If totalSteps is large, this may make the pickup not worth it.
            const revisedUtility = [ ...carried, parcel ].reduce(
                (sum, p) => sum + Math.max(0, p.reward - totalSteps * decayPerStep), 0);

            if ( revisedUtility < 1 ) return -1; // If all parcels would have 0 or negative utility, skip pickup

            return revisedUtility;
        }

        if ( action === 'explore' ) return 0;

        return -1;
    }

    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        // console.log( 'Revising intention queue. Received', ...predicate );
        
        // 1. Evaluate validity of intention
        const utility = this.getUtility( predicate );
        if ( utility < 0 ) {
            console.log( '\tIntention rejected (invalid or low utility):', ...predicate );
            return; 
        }

        // At most one go_deliver allowed in the queue at a time.
        // If one already exists with the same destination, skip; otherwise replace it.
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

        // Create and push the new intention
        const newIntention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( newIntention );

        // Keep a reference to what is currently executing
        const currentTop = this.intention_queue[0];

        // 2. Order intentions based on utility function (Highest utility first)
        this.intention_queue.sort( ( a, b ) => {
            return this.getUtility( b.predicate ) - this.getUtility( a.predicate );
        } );

        // 3. Preempt current if a higher-utility intention is now at the top
        const newTop = this.intention_queue[0];
        if ( currentTop && currentTop !== newTop && !currentTop.stopped ) {
            currentTop.stop();
            const index = this.intention_queue.indexOf( currentTop );
            if ( index > -1 ) this.intention_queue.splice( index, 1 );
        }

        // 4. Prune any intentions anywhere in the queue that have become invalid.
        //    This cleans up go_pick_up entries for parcels grabbed opportunistically.
        for ( let i = this.intention_queue.length - 1; i >= 0; i-- ) {
            if ( this.getUtility( this.intention_queue[ i ].predicate ) < 0 ) {
                this.intention_queue[ i ].stop();
                this.intention_queue.splice( i, 1 );
            }
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

    // Plan currently used for achieving the desire 
    /** @type { Plan | undefined } */
    #current_plan;

    // This is used to stop the intentionDeliberation
    #stopped = false;
    get stopped () { return this.#stopped; }
    
    stop () {
        this.log( 'stop intentionDeliberation', ...this.#predicate );
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    /**
     * #parent refers to caller
     */
    #parent;

    /**
     * Desire to be achieved, for example ['go_to', x, y]
     * @type { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
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
    /**
     * Using the plan library to achieve an intention
     * @returns { Promise<boolean> } the result of the plan execution
     */
    async achieve () {
        // Cannot start twice
        if ( this.#started ) return false;
        this.#started = true;

        // Trying all plans in the library
        for ( const planClass of planLibrary ) {

            // if stopped then quit
            if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
            
             // if plan is 'statically' applicable to the desire, then execute it
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                // plan is instantiated with a reference to the current intention (this) as its parent, so it can call subIntention if needed
                this.#current_plan = new planClass( this.#parent );
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
                // and plan is executed and result returned to the caller (true if achieved, false if failed but no error, or error thrown if failed with error) 
                try {
                    const res = await this.#current_plan?.execute( ...this.predicate );
                    this.log( 'succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', res );
                    return res || false;
                } catch ( error ) {
                    this.log( 'failed', ...this.predicate, 'error:', error );
                }
            }
        }

        if ( this.stopped ) throw [ 'stopped', ...this.predicate ];
        
        // no plans have been found to satisfy the intention
        throw [ 'no plan satisfied', ...this.predicate ];
    }
}