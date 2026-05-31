import { hostsStatus, launchAgentStatus, loadStateForScript, stateSealStatus } from "../src/hardening.js";
import { doctorRows, formatDoctorRows } from "../src/doctorReport.js";
import { sourceSealStatus } from "../src/sourceSeal.js";
import { currentMacAccountStatus } from "../src/account.js";

const state = await loadStateForScript();
const seal = await stateSealStatus(state);
const sourceSeal = await sourceSealStatus();
const hosts = await hostsStatus(state);
const agent = await launchAgentStatus();
const account = await currentMacAccountStatus();

console.log(formatDoctorRows(doctorRows(state, { seal, sourceSeal, hosts, agent, account })));
