import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';
import 'dotenv/config';

// ─── Socket Singleton ─────────────────────────────────────────────────────────

export const socket = DjsConnect( process.env.HOST, process.env.TOKEN );
