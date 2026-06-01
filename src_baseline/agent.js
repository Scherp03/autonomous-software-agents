import { planLibrary } from './plans.js';

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

export class IntentionRevisionReplace extends IntentionRevision {
    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        const current = this.intention_queue[0];

        // // A safer shallow equality check instead of .join(' ')
        // if ( current && JSON.stringify(current.predicate) == JSON.stringify(predicate) ) {
        //     return; 
        // }

        // Check if already queued
        const last = this.intention_queue.at( this.intention_queue.length - 1 );
        if ( last && last.predicate.join(' ') == predicate.join(' ') ) {
            return; // intention is already being achieved
        }

        // console.log( 'IntentionRevisionReplace.push', predicate );

        const intention = new IntentionDeliberation( this, predicate );
        
        // Stop the currently executing intention
        // if ( current ) current.stop();
        if ( last ) last.stop();

        // Completely replace the queue instead of pushing to the end
        this.intention_queue.length = 0; 
        this.intention_queue.push( intention );
    }
}

export class IntentionRevisionRevise extends IntentionRevision {

    /**
     * Helper method to evaluate the validity and utility of an intention.
     * Utility is calculated as: Reward - Cost (distance).
     * Returns -1 if the intention is invalid.
     */
    getUtility ( predicate ) {
        const [ action, x, y, id ] = predicate;
        
        if ( action === 'go_deliver' ) {
            // Delivering is critical. High base reward minus distance cost.
            return 1000 - distance( me, { x, y } );
        }
        
        if ( action === 'go_pick_up' ) {
            const parcel = parcels.get( id );
            
            // EVALUATE VALIDITY: If parcel disappeared or is carried by someone else, it's invalid.
            if ( !parcel || ( parcel.carriedBy && parcel.carriedBy !== me.id ) ) {
                return -1; 
            }
            
            // UTILITY: Parcel score (reward) minus distance (cost)
            return parcel.reward - distance( me, { x, y } );
        }
        
        if ( action === 'explore' ) {
            // Exploring is the lowest priority fallback.
            return 0;
        }
        
        return -1; // Unknown intention
    }

    /**
     * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
     */
    async push ( predicate ) {
        console.log( 'Revising intention queue. Received', ...predicate );
        
        // 1. Evaluate validity of intention
        const utility = this.getUtility( predicate );
        if ( utility < 0 ) {
            console.log( '\tIntention rejected (invalid or low utility):', ...predicate );
            return; 
        }

        // Check if this exact intention is already in the queue to avoid duplicates
        const isDuplicate = this.intention_queue.some( 
            i => i.predicate.join(' ') === predicate.join(' ') 
        );
        if ( isDuplicate ) {
            return; 
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

        // 3. Eventually stop current one if preempted
        const newTop = this.intention_queue[0];
        
        // If sorting changed the top of the queue, the current plan is no longer the highest priority
        if ( currentTop && currentTop !== newTop && !currentTop.stopped ) {
            console.log( '\tPreempting current intention for a higher utility one.' );
            
            // Stop the executing plan
            currentTop.stop();
            
            // Prune the stopped intention from the queue so it doesn't linger as a dead object
            const index = this.intention_queue.indexOf( currentTop );
            if ( index > -1 ) {
                this.intention_queue.splice( index, 1 );
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