export function terminalCommand(args: string[]): { help: true } | { help?: false; command: string; target: string; verbose: boolean; args: string[] };
export function updateFailureHelp(output: string): string;
