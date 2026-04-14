import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;    
const TOKEN = process.env.TOKEN;

const socket = DjsConnect(
    HOST,
    TOKEN
    );

// hard coded values

// const socket = DjsConnect(
//     'https://localhost:8080',
//     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNlZjkyYyIsIm5hbWUiOiJwcm92YSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzc2MDk5MTgxfQ.1v3Pe6hM7cEV5VjGIj7pwx6L-dBqzlTSwxtZq2P9CEI'
// );

// const socket = DjsConnect(
//     'https://deliveroojs.azurewebsites.net/',
//     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjdlNTgyMyIsIm5hbWUiOiJndWd1Z2FnYSIsInRlYW1JZCI6IjUzNTU0MCIsInRlYW1OYW1lIjoid3RmIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NzYwOTE2Njl9.6LcyptG_av0gaOriYQxeE-v1hz2-WV3B9iz74TUtXDg'
// );


/*
GAME ACTIONS:
-Movement
const result = await socket.emitMove('up'); // 'right', 'left', 'down'
// Returns: {x, y} on success, false on failure
-Pickup Parcels
const parcels = await socket.emitPickup();
// Returns: [{id, x, y, carriedBy, reward}, ...]
-Drop Parcels
const dropped = await socket.emitPutdown(selected);
// selected: array of parcel IDs (or undefined for all)


------------------------------------------------------------


EVENT LISTENERS:

-Agent identity
socket.onYou( me => { ... });
me.(id, name, x, y, score)

-Map information
socket.onMap( width, height, tiles => { ... });

socket.on('map', (width, height, tiles) => {  ... });
socket.on('tile', (x, y, delivery) => { ... });

-Sensing
socket.on('agentsSensing', (agents) => { ... });
socket.on('parcelsSensing', (parcels) => { ... });

-Connection
socket.on('connect', () => { ... });
socket.on('disconnect', () => { ... });
*/


// FULL EXAMPLE

let myPosition = { x: 0, y: 0 };

socket.onYou( me => {
    myPosition = { x: me.x, y: me.y };
    console.log('My position:', myPosition);
});

// wait for the map information to be received before starting to move
socket.on('map', async (width, height, tiles) => {
    // console.log('Map received:', width, height, tiles);

    // Move along predefined path
    const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
    for (const direction of path) {
        const result = await socket.emitMove(direction);
        if (!result) {
            console.log(`Move ${direction} failed, retrying...`);
            // not needed
            await new Promise(r => setTimeout(r, 100));
            // Retry logic here
        }
    }
    // Pickup parcels
    await socket.emitPickup();
});

// EXAMPLE: handle failures when multiple agents compete for resources
async function resilientMove(direction, maxRetries = 3) {
for (let i = 0; i < maxRetries; i++) {
    const result = await socket.emitMove(direction);
    if (result) return result;
    
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Alternative path or request help
    await socket.emitShout(`Help! Blocked trying to move ${direction}`);
    return null;
}
