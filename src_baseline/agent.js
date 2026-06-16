import { planLibrary } from './plans.js';
import { me, parcels } from './beliefs.js';
import { distance } from './utils.js';

export class IntentionRevision {

    /** @type {IntentionDeliberation[]} */
    #intention_queue = [];
    get intention_queue () { return this.#intention_queue; }

    async loop () {
        while ( true ) {
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
                await new Promise( res => setImmediate( res ) );
            }
        }
    }

    /** @type { function(...any): void } */
    log ( ...args ) { console.log( ...args ); }

    /**
     * @abstract
     * @param { [string, ...any] } predicate
     */
    async push ( predicate ) {}
}

export class IntentionRevisionReplace extends IntentionRevision {
    async push ( predicate ) {
        const last = this.intention_queue.at( this.intention_queue.length - 1 );
        if ( last && last.predicate.join(' ') == predicate.join(' ') ) {
            return;
        }

        const intention = new IntentionDeliberation( this, predicate );
        if ( last ) last.stop();
        this.intention_queue.length = 0;
        this.intention_queue.push( intention );
    }
}

export class IntentionRevisionRevise extends IntentionRevision {

    getUtility ( predicate ) {
        const [ action, x, y, id ] = predicate;

        if ( action === 'go_deliver' ) {
            return 1000 - distance( me, { x, y } );
        }

        if ( action === 'go_pick_up' ) {
            const parcel = parcels.get( id );
            if ( !parcel || ( parcel.carriedBy && parcel.carriedBy !== me.id ) ) return -1;
            return parcel.reward - distance( me, { x, y } );
        }

        if ( action === 'explore' ) return 0;

        return -1;
    }

    async push ( predicate ) {
        console.log( 'Revising intention queue. Received', ...predicate );

        // 1. Validate
        const utility = this.getUtility( predicate );
        if ( utility < 0 ) {
            console.log( '\tIntention rejected (invalid or low utility):', ...predicate );
            return;
        }

        const isDuplicate = this.intention_queue.some(
            i => i.predicate.join(' ') === predicate.join(' ')
        );
        if ( isDuplicate ) return;

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
            console.log( '\tPreempting current intention for a higher utility one.' );
            currentTop.stop();
            const index = this.intention_queue.indexOf( currentTop );
            if ( index > -1 ) this.intention_queue.splice( index, 1 );
        }
    }
}

export class IntentionDeliberation {

    /** @type { Plan | undefined } */
    #current_plan;

    #stopped = false;
    get stopped () { return this.#stopped; }

    stop () {
        this.log( 'stop intentionDeliberation', ...this.#predicate );
        this.#stopped = true;
        if ( this.#current_plan ) this.#current_plan.stop();
    }

    #parent;

    /** @type { [string, ...any] } */
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
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
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
        throw [ 'no plan satisfied', ...this.predicate ];
    }
}
