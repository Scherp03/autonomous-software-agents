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
    return new Promise( resolve => { resumeResolver = resolve; } );
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
            agentRef.unfreeze();
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
