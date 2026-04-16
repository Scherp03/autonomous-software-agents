import { parcels } from './beliefs.js';
import { planLibrary } from './plans.js';

export class IntentionRevision {
    #intention_queue = [];
    get intention_queue () { return this.#intention_queue; }

    async loop () {
        while ( true ) {
            if ( this.intention_queue.length > 0 ) {
                const intention = this.intention_queue[ 0 ];

                if ( intention.predicate[ 0 ] === 'go_pick_up' ) {
                    const id = intention.predicate[ 3 ];
                    const p  = parcels.get( id );
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
            await new Promise( res => setImmediate( res ) );
        }
    }

    log ( ...args ) { console.log( ...args ); }

    async push ( predicate ) {}
}

export class IntentionRevisionReplace extends IntentionRevision {
    async push ( predicate ) {
        const last = this.intention_queue.at( -1 );
        if ( last && last.predicate.join(' ') === predicate.join(' ') ) return;

        const intention = new IntentionDeliberation( this, predicate );
        this.intention_queue.push( intention );

        if ( last ) last.stop();
    }
}

export class IntentionDeliberation {
    #current_plan;
    #stopped = false;
    get stopped () { return this.#stopped; }
    
    stop () {
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    #parent;
    #predicate;
    get predicate () { return this.#predicate; }

    constructor ( parent, predicate ) {
        this.#parent    = parent;
        this.#predicate = predicate;
    }

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