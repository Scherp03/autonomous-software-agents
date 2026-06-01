import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;
const TOKEN = process.env.TOKEN;

if (!TOKEN) throw new Error("TOKEN env var is required");

export const socket = DjsConnect(HOST, TOKEN);