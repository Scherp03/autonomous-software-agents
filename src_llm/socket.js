import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk";
import "dotenv/config";

const HOST = process.env.HOST;    
const TOKEN_LLM = process.env.TOKEN_LLM;

export const socket = DjsConnect(HOST, TOKEN_LLM);