import { buildResolvedHostsBlock, loadStateForScript } from "../src/hardening.js";
import { buildResolvedFirewallBlock, buildPfConfBlock } from "../src/firewall.js";

const state = await loadStateForScript();
console.log(await buildResolvedHostsBlock(state));
console.log("");
console.log(buildPfConfBlock());
console.log("");
const firewall = await buildResolvedFirewallBlock(state);
console.log(firewall.block);
