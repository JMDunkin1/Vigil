import { hostsStatus, launchAgentStatus, loadStateForScript, stateSealStatus } from "../src/hardening.js";
import { firewallStatus } from "../src/firewall.js";
import { doctorRows, formatDoctorRows } from "../src/doctorReport.js";
import { sourceSealStatus } from "../src/sourceSeal.js";
import { currentMacAccountStatus } from "../src/account.js";
import { safariFilterStatus } from "../src/safariFilter.js";
import { chromeSafeSearchStatus } from "../src/chromeSafeSearch.js";

const state = await loadStateForScript();
const seal = await stateSealStatus(state);
const sourceSeal = await sourceSealStatus();
const hosts = await hostsStatus(state);
const firewall = await firewallStatus(state);
const safariFilter = await safariFilterStatus(state);
const chromeSafeSearch = await chromeSafeSearchStatus();
const agent = await launchAgentStatus();
const account = await currentMacAccountStatus();

console.log(formatDoctorRows(doctorRows(state, { seal, sourceSeal, hosts, firewall, safariFilter, chromeSafeSearch, agent, account })));
