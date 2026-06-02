import { watch, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { socket } from './socket.js';

const __dir = dirname( fileURLToPath( import.meta.url ) );
export const SLAVE_COMMAND_PATH = join( __dir, '..', 'slave-command.json' );
export const SLAVE_STATUS_PATH  = join( __dir, '..', 'slave-status.json' );

let agentRef = null;
export function setAgent ( agent ) { agentRef = agent; }

// Resolved by the file watcher when a RESUME command arrives.
// GoToNeighborhood awaits this to unblock after arriving.
let resumeResolver = null;
export function waitForResume () {
    return new Promise( ( resolve, reject ) => {
        resumeResolver = resolve;
        setTimeout( () => {
            if ( resumeResolver ) {
                resumeResolver = null;
                reject( [ 'waitForResume: timed out after 120s — RESUME never received' ] );
            }
        }, 120000 );
    } );
}

// Resolved when HANDOFF_MOVE_IN is received — unblocks HandoffSlave after LLM has vacated T_llm.
let handoffMoveInResolver = null;
export function waitForHandoffMoveIn () {
    return new Promise( ( resolve, reject ) => {
        handoffMoveInResolver = resolve;
        setTimeout( () => {
            if ( handoffMoveInResolver ) { handoffMoveInResolver = null; reject( [ 'handoff: timeout waiting for HANDOFF_MOVE_IN' ] ); }
        }, 60000 );
    } );
}

function processCommand () {
    if ( !existsSync( SLAVE_COMMAND_PATH ) ) return;
    try {
        const cmd = JSON.parse( readFileSync( SLAVE_COMMAND_PATH, 'utf8' ) );
        if ( cmd.cmd === 'GO_TO_MATCHING_TILE' && agentRef ) {
            console.log( `[slave-command] GO_TO_MATCHING_TILE — condition: "${cmd.condition}", pts: ${cmd.pts ?? 500}` );
            agentRef.pushUrgent( [ 'go_to_matching_tile', cmd.condition, cmd.pts ?? 500 ] );
        } else if ( cmd.cmd === 'GO_TO_NEIGHBORHOOD' && agentRef ) {
            console.log( `[slave-command] GO_TO_NEIGHBORHOOD — ${cmd.tiles.length} tiles, ${cmd.pts} pts` );
            agentRef.pushUrgent( [ 'go_to_neighborhood', cmd.tiles, cmd.pts ] );
        } else if ( cmd.cmd === 'RESUME' ) {
            console.log( '[slave-command] RESUME received.' );
            if ( resumeResolver ) {
                resumeResolver();
                resumeResolver = null;
            }
        } else if ( cmd.cmd === 'FREEZE' && agentRef ) {
            console.log( '[slave-command] FREEZE received.' );
            agentRef.freeze();
        } else if ( cmd.cmd === 'UNFREEZE' && agentRef ) {
            console.log( '[slave-command] UNFREEZE received.' );
            const q = agentRef.intention_queue;
            if ( q.length > 0 && [ 'go_to_edge', 'go_to_matching_tile', 'go_to_neighborhood' ].includes( q[0].predicate[0] ) ) {
                q[0].stop();
            }
            agentRef.unfreeze();
        } else if ( cmd.cmd === 'MOVE_TO_EDGE' && agentRef ) {
            console.log( `[slave-command] MOVE_TO_EDGE — pts=${cmd.pts ?? 500}` );
            agentRef.pushUrgent( [ 'go_to_edge', cmd.pts ?? 500 ] );
        } else if ( cmd.cmd === 'HANDOFF_GOTO' && agentRef ) {
            console.log( `[slave-command] HANDOFF_GOTO — T_slave(${cmd.T_slave_x},${cmd.T_slave_y}) T_llm(${cmd.T_llm_x},${cmd.T_llm_y}) dir=${cmd.dir}` );
            agentRef.pushUrgent( [ 'handoff_slave', cmd.T_slave_x, cmd.T_slave_y, cmd.T_llm_x, cmd.T_llm_y, cmd.dir ] );
        } else if ( cmd.cmd === 'HANDOFF_MOVE_IN' ) {
            console.log( '[slave-command] HANDOFF_MOVE_IN received.' );
            if ( handoffMoveInResolver ) { handoffMoveInResolver(); handoffMoveInResolver = null; }
        } else if ( cmd.cmd === 'SAY' ) {
            console.log( `[slave-command] SAY to ${cmd.toId}: ${cmd.message}` );
            socket.emitAsk( cmd.toId, cmd.message );
        }
    } catch ( e ) {
        console.error( '[slave-command] Failed to parse:', e.message );
    }
}

// Watch the project root for writes to slave-command.json.
// This runs outside the BDI loop so it works even while a plan is blocking.
let debounceTimer = null;
watch( join( __dir, '..' ), ( _event, filename ) => {
    if ( filename !== 'slave-command.json' ) return;
    clearTimeout( debounceTimer );
    debounceTimer = setTimeout( processCommand, 50 );
} );
