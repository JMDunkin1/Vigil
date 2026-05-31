import { writeSourceSeal } from "../src/sourceSeal.js";

const result = await writeSourceSeal();
console.log(`${result.detail} Sealed at ${result.sealedAt}.`);
