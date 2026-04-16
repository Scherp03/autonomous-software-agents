import { planLibrary } from './plan-library.js';
import { parcels } from './beliefs.js';

// ─── Intention Revision ───────────────────────────────────────────────────────

export class IntentionRevision {
    /** @type {IntentionDeliberation[]} */
    #intention_queue = [];
    get intention_queue() { return this.#intention_queue; }

    async loop() {
        while ( true ) {
            if ( this.intention_queue.length > 0 ) {
                const intention = this.intention_queue[0];

                // Discard stale go_pick_up intentions before executing them
                if ( intention.predicate[0] === 'go_pick_up' ) {
                    const id = intention.predicate[3];
                    const p  = parcels.get(id);
                    if ( !p || p.carriedBy ) {
                        this.intention_queue.shift();
                        continue;
                    }
                }

                await intention.achieve().catch( err => {
                    // Intentionally swallow errors so the loop continues
                } );

                this.intention_queue.shift();
            }
            await new Promise( res => setImmediate(res) );
        }
    }

    log( ...args ) { console.log( ...args ); }

    async push( predicate ) {}
}

export class IntentionRevisionReplace extends IntentionRevision {
    async push( predicate ) {
        const current = this.intention_queue[0];
        if ( current && current.predicate.join(' ') === predicate.join(' ') ) return;

        // Discard all pending-but-not-executing intentions
        this.intention_queue.splice(1);
        // Enqueue the new intention; the loop will reach it after current stops
        this.intention_queue.push( new IntentionDeliberation(this, predicate) );
        // Interrupt the currently-executing intention (loop will shift() it when done)
        if ( current ) current.stop();
    }
}

// ─── Intention Deliberation ───────────────────────────────────────────────────

export class IntentionDeliberation {
    #current_plan;
    #stopped = false;
    get stopped() { return this.#stopped; }

    stop() {
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    #parent;
    #predicate;
    get predicate() { return this.#predicate; }

    constructor( parent, predicate ) {
        this.#parent    = parent;
        this.#predicate = predicate;
    }

    log( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    #started = false;
    async achieve() {
        if ( this.#started ) return false;
        this.#started = true;

        for ( const planClass of planLibrary ) {
            if ( this.stopped ) throw [ 'stopped', ...this.predicate ];

            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                this.#current_plan = new planClass( this.#parent );
                try {
                    const res = await this.#current_plan.execute( ...this.predicate );
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

// ─── Plan Base ────────────────────────────────────────────────────────────────

export class PlanBase {
    #stopped = false;
    stop() {
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) i.stop();
    }
    get stopped() { return this.#stopped; }

    #parent;
    constructor( parent ) { this.#parent = parent; }

    log( ...args ) {
        if ( this.#parent?.log ) this.#parent.log( '\t', ...args );
        else console.log( ...args );
    }

    #sub_intentions = [];
    async subIntention( predicate ) {
        const sub = new IntentionDeliberation( this, predicate );
        this.#sub_intentions.push( sub );
        return sub.achieve();
    }
}
