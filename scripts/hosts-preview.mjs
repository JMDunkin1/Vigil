import { buildHostsBlock, loadStateForScript } from "../src/hardening.js";

const state = await loadStateForScript();
console.log(buildHostsBlock(state));
