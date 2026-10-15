"""Compile packaged rules with Chromium's RE2 settings, including its 2 KiB cap.

Requires Google's google-re2 package. This is a compiler check, not a claim
that the extension has been installed or qualified in the user's browser.
"""
import json
import pathlib
import sys
import re2

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/runtime/extension')
manifest = json.loads((source / 'manifest.json').read_text())
rejected = []
total = 0
regex_count = 0
max_program_size = 0
for resource in manifest['declarative_net_request']['rule_resources']:
    assert resource['enabled'], 'A required ruleset is disabled'
    rules = json.loads((source / resource['path']).read_text())
    assert len({rule['id'] for rule in rules}) == len(rules), 'Duplicate static rule IDs'
    total += len(rules)
    for rule in rules:
        if 'regexFilter' not in rule['condition']:
            continue
        regex_count += 1
        options = re2.Options()
        options.encoding = re2.Options.Encoding.LATIN1
        options.case_sensitive = rule['condition'].get('isUrlFilterCaseSensitive', False)
        options.never_capture = 'regexSubstitution' not in rule['action'].get('redirect', {})
        options.log_errors = False
        options.max_mem = 2048
        try:
            compiled = re2.compile(rule['condition']['regexFilter'].encode('ascii'), options=options)
            max_program_size = max(max_program_size, compiled.programsize)
        except re2.error as error:
            rejected.append({'ruleset': resource['id'], 'id': rule['id'], 'error': str(error)})
report = {'engine': 'Google RE2', 'maxMemBytes': 2048, 'totalRules': total,
          'regexRules': regex_count, 'maximumProgramSize': max_program_size, 'rejected': rejected}
print(json.dumps(report, indent=2))
assert regex_count < 1000, 'Static expressions exceed Chromium quota'
assert not rejected, 'Required expressions exceed the Chromium compiler budget'
