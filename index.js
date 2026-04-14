import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;    
const TOKEN = process.env.TOKEN;

const socket = DjsConnect(
    HOST,
    TOKEN
    );

let myPosition = { x: 0, y: 0 };

socket.onYou( me => {
    myPosition = { x: me.x, y: me.y };
    console.log('My position:', myPosition);
});

// wait for the map information to be received before starting to move
socket.on('map', async (width, height, tiles) => {
    // console.log('Map received:', width, height, tiles);

    // Move along predefined path
    const path = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'up', 'right', 'right', 'down', 'down', 'left', 'left', 'up', 'up'];
    
    while (true) {
        for (const direction of path) {
            const result = await socket.emitMove(direction);
            if (!result) {
                console.log(`Move ${direction} failed, retrying...`);
            }
        }
        await new Promise(r => setTimeout(r, 1000));
    }
});