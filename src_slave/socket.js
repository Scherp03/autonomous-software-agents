import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;    
const TOKEN = process.env.TOKEN;

export const socket = DjsConnect(HOST, TOKEN);