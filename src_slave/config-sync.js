import { watch, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dynamicRules } from './beliefs.js';

const __dir = dirname( fileURLToPath( import.meta.url ) );
export const SHARED_CONFIG_PATH = join( __dir, '..', 'shared-config.json' );

function applySharedConfig () {
    if ( !existsSync( SHARED_CONFIG_PATH ) ) return;
    try {
        const config = JSON.parse( readFileSync( SHARED_CONFIG_PATH, 'utf8' ) );

        if ( Array.isArray( config.forbiddenTiles ) ) {
            dynamicRules.forbiddenTiles.clear();
            for ( const t of config.forbiddenTiles ) dynamicRules.forbiddenTiles.add( t );
        }
        if ( config.deliveryMultipliers ) {
            dynamicRules.deliveryMultipliers.clear();
            for ( const [ k, v ] of Object.entries( config.deliveryMultipliers ) )
                dynamicRules.deliveryMultipliers.set( k, v );
        }
        dynamicRules.stackSizeRule   = config.stackSizeRule   ?? null;
        dynamicRules.parcelMaxReward = config.parcelMaxReward ?? Infinity;
        if ( config.bonusTiles ) {
            dynamicRules.bonusTiles.clear();
            for ( const [ k, v ] of Object.entries( config.bonusTiles ) )
                dynamicRules.bonusTiles.set( k, v );
        }
        if ( config.edgeRules ) {
            dynamicRules.edgeRules.clear();
            for ( const [ k, v ] of Object.entries( config.edgeRules ) )
                dynamicRules.edgeRules.set( k, v );
        }
        console.log( '[config-sync] Applied shared config from LLM agent.' );
    } catch ( e ) {
        console.error( '[config-sync] Failed to parse shared config:', e.message );
    }
}

// Apply any config the LLM wrote before we started
applySharedConfig();

// Watch the project root directory for writes to shared-config.json.
// Debounce 50 ms because some editors trigger two change events per save.
let debounceTimer = null;
watch( join( __dir, '..' ), ( _event, filename ) => {
    if ( filename !== 'shared-config.json' ) return;
    clearTimeout( debounceTimer );
    debounceTimer = setTimeout( applySharedConfig, 50 );
} );
