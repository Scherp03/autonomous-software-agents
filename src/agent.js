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
                // Fix CPU starvation: Wait 10ms instead of instant setImmediate spinning
                // await new Promise( res => setTimeout( res, 10 ) );
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