"""Repartition the baseline matcher and add search-only age restrictions.

The fixture combines the contextual matcher at searchBaseRef with enforcement
metadata at searchMetadataRef, including top-level and embedded frame coverage.

Install Google's google-re2 package, then run this script with --write to
regenerate extension/rules.json. Without --write, verify the generated output.
The same strict RE2 options as tests/extension-dnr-budget.py apply here.

DNR receives canonical HTTP(S) network URLs: spaces are escaped and fragments
are removed. The manifest's host permissions restrict these redirects to those
schemes. The canonical simplifications below rely on that execution contract;
query field parsing and all contextual token boundaries remain intact.

Partitions distribute only unquantified/optional alternatives. A{2,} becomes
AA+ before distribution, preserving mixed repeated tokens. Final AST unions
factor common prefixes/suffixes exactly, keeping the set within the regex quota.
"""
import argparse
import copy
import json
import pathlib
import re
import re2

def canonical_matcher(expression):
    regex = expression.replace('[ +._-]|%20|%2b|%2d|%5f|%2e', '[ +._-]|%2[0bde]|%5f')
    regex = regex.replace('(?:[^&#]*&)*', '(?:[^#]*&)?').replace('https?', 'http(?:s)?').replace('[57]', '(?:5|7)').replace('[46]', '(?:4|6)').replace('[o0]', '(?:o|0)')
    regex = regex.replace('[^/?#]+/[^?#]*', '[^?#]*').replace('sex|nud(?:s|es?)?|p(?:o|0)rn|r34|nsfw', 'sex|n(?:ud(?:s|es?)?|sfw)|p(?:o|0)rn|r34')
    repeat = '(?:sex|n(?:ud(?:s|es?)?|sfw)|p(?:o|0)rn|r34)'
    regex = regex.replace(repeat + '{2,}', repeat + repeat + '+')
    regex = re.sub('([a-z0-9])\\?', '(?:\\1)?', regex).replace('^http(?:s)?://', '^')
    regex = regex.replace('[^?#]', '[^?]').replace('[^#]', '(?s:.)').replace('[^&#]', '[^&]').replace('[&#]', '&')
    regex = regex.replace('(?:q|query|search_query|search|searchterm|search_term|keyword|keywords|term|text|wd|word|tags|tag)', '(?:q(?:uery)?|search(?:_query|_?term)?|keywords?|te(?:rm|xt)|w(?:d|ord)|tags?)')
    regex = re.sub('([a-z0-9_])\\?', '(?:\\1)?', regex)
    regex = regex.replace('[ +._-]', '[+._-]')
    return regex

def compiles(expression):
    options = re2.Options()
    options.encoding = re2.Options.Encoding.LATIN1
    options.case_sensitive = False
    options.never_capture = True
    options.log_errors = False
    options.max_mem = 2048
    try:
        return re2.compile(expression.encode('ascii'), options=options).programsize
    except re2.error:
        return None

def alternatives(expression):
    groups = []
    stack = []
    in_class = False
    escaped = False
    for (index, character) in enumerate(expression):
        if escaped:
            escaped = False
            continue
        if character == '\\':
            escaped = True
            continue
        if in_class:
            if character == ']':
                in_class = False
            continue
        if character == '[':
            in_class = True
        elif character == '(':
            stack.append({'start': index, 'bars': [], 'parent': stack[-1] if stack else None})
        elif character == '|':
            if stack:
                stack[-1]['bars'].append(index)
        elif character == ')':
            group = stack.pop()
            group['end'] = index
            group['repeated'] = index + 1 < len(expression) and expression[index + 1] in '*+{'
            groups.append(group)
    for group in groups:
        ancestor = group
        while ancestor and (not ancestor['repeated']):
            ancestor = ancestor['parent']
        if ancestor:
            continue
        if group['end'] + 1 < len(expression) and expression[group['end'] + 1] == '?':
            yield (group['start'], group['end'] + 2, ['', expression[group['start']:group['end'] + 1]])
        if not group['bars']:
            continue
        start = group['start'] + (3 if expression[group['start']:].startswith('(?:') else 1)
        stop = group['end']
        parts = [expression[a:b] for (a, b) in zip([start] + [bar + 1 for bar in group['bars']], group['bars'] + [stop])]
        yield (start, stop, parts)

def partition(expression):
    size = compiles(expression)
    if size is not None:
        return [(expression, size)]
    candidates = []
    for (start, stop, parts) in alternatives(expression):
        for split in range(1, len(parts)):
            children = [expression[:start] + '|'.join(part) + expression[stop:] for part in [parts[:split], parts[split:]]]
            candidates.append((max(map(len, children)), children))
    if not candidates:
        raise ValueError('Cannot partition: ' + expression)
    (_, children) = min(candidates, key=lambda candidate: candidate[0])
    return [item for child in children for item in partition(child)]

def seq(items):
    flattened = []
    for item in items:
        flattened.extend(item[1] if item[0] == 'seq' else [item])
    return flattened[0] if len(flattened) == 1 else ('seq', tuple(flattened))

def sequence(item):
    return item[1] if item[0] == 'seq' else (item,)

def alt(items):
    unique = []
    for item in items:
        for part in item[1] if item[0] == 'alt' else [item]:
            if part not in unique:
                unique.append(part)
    if len(unique) == 1:
        return unique[0]
    sequences = [sequence(item) for item in unique]
    before = 0
    while all((len(item) > before for item in sequences)) and all((item[before] == sequences[0][before] for item in sequences)):
        before += 1
    after = 0
    while all((len(item) > before + after for item in sequences)) and all((item[-1 - after] == sequences[0][-1 - after] for item in sequences)):
        after += 1
    if before or after:
        middles = [seq(item[before:len(item) - after if after else len(item)]) for item in sequences]
        return seq(list(sequences[0][:before]) + [alt(middles)] + (list(sequences[0][-after:]) if after else []))
    return ('alt', tuple(unique))

def parse(expression):
    index = 0

    def group():
        nonlocal index
        alternatives = []
        parts = []
        while index < len(expression):
            character = expression[index]
            if character == ')':
                break
            if character == '|':
                alternatives.append(seq(parts))
                parts = []
                index += 1
                continue
            if character == '(':
                assert expression[index:index + 3] == '(?:', expression[index:]
                index += 3
                item = group()
                assert expression[index] == ')'
                index += 1
            elif character == '[':
                start = index
                index += 1
                while expression[index] != ']':
                    index += 2 if expression[index] == '\\' else 1
                index += 1
                item = ('atom', expression[start:index])
            elif character == '\\':
                item = ('atom', expression[index:index + 2])
                index += 2
            else:
                item = ('atom', character)
                index += 1
            if index < len(expression) and expression[index] in '?*+':
                item = ('repeat', item, expression[index])
                index += 1
            elif index < len(expression) and expression[index] == '{':
                stop = expression.index('}', index) + 1
                item = ('repeat', item, expression[index:stop])
                index = stop
            parts.append(item)
        alternatives.append(seq(parts))
        return alt(alternatives)
    result = group()
    assert index == len(expression)
    return result

def render(item):
    kind = item[0]
    if kind == 'atom':
        return item[1]
    if kind == 'seq':
        return ''.join((render(child) for child in item[1]))
    if kind == 'alt':
        return '(?:' + '|'.join((render(child) for child in item[1])) + ')'
    if kind == 'repeat':
        text = render(item[1])
        if item[1][0] == 'seq':
            text = '(?:' + text + ')'
        return text + item[2]
    raise ValueError(item)

def merge_partitions(expressions):
    asts = {render(parse(e)): parse(e) for e in expressions}
    for _round in range(10):
        previous = len(asts)
        for reverse in [False, True]:
            texts = sorted(asts, key=(lambda text: text[::-1]) if reverse else None)
            for (index, text) in enumerate(texts):
                if text not in asts:
                    continue
                best = None
                for other in texts[index + 1:index + 25]:
                    if other not in asts:
                        continue
                    merged = alt([asts[text], asts[other]])
                    candidate = render(merged)
                    size = compiles(candidate)
                    if size is not None and (best is None or size < best[0]):
                        best = (size, other, merged, candidate)
                if best:
                    (_, other, merged, candidate) = best
                    del asts[text]
                    del asts[other]
                    asts[candidate] = merged
        if len(asts) == previous:
            break
    return list(asts)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parent.parent
    fixture = json.loads((root / 'tests/fixtures/extension-dnr-contextual-base.json').read_text())
    assert fixture['searchBaseRef'] == '296c5e6648b5c0d917b6c524e3d449ede2575b0a'
    assert fixture['searchMetadataRef'] == '3258db6d354f2d6253056528b76215287c2e146f'
    base = fixture['search']
    assert all(rule['condition']['resourceTypes'] == ['main_frame', 'sub_frame'] for rule in base), 'Search rules must protect top-level and embedded frames'
    manifest = json.loads((root / 'extension/manifest.json').read_text())
    assert {'http://*/*', 'https://*/*'} <= set(manifest['host_permissions'])
    assert all((permission.startswith(('http://', 'https://')) for permission in manifest['host_permissions']))
    expression = canonical_matcher(base[3]['condition']['regexFilter'])
    expressions = [expression.replace('(?s:.)', '[\\s\\S]') for (expression, _) in partition(expression)]
    expressions = merge_partitions(expressions)
    rules = copy.deepcopy(base[:3])
    for (index, expression) in enumerate(expressions):
        rule = copy.deepcopy(base[3])
        rule['id'] = 4 if index == 0 else index + 6
        rule['condition']['regexFilter'] = expression
        rules.append(rule)
    rules.extend(copy.deepcopy(base[4:]))
    # Deliberately additive to the frozen baseline. Match declared search text,
    # never IDs, arbitrary URL fragments, or 18+5 arithmetic. Literal URL '+'
    # is a form-space; a searched plus sign is percent encoded.
    age = copy.deepcopy(base[3])
    age['condition']['regexFilter'] = (
        r'^https?://[^/?#]+/[^?#]*\?(?:[^&#]*&)*'
        r'(?:q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|wd|word|tags|tag|gsc\.q|search_api_fulltext)='
        r'(?:[^&#]*(?:[+_.-]|%20|%2[bdef]|%5f))?'
        r'(?:18(?:%(?:25){0,3}2b|(?:[+_.-]|%20|%2d|%5f)*plus)|eighteen(?:[+_.-]|%20)+plus)'
        r'(?:$|&|[+_.-]|%20|%2[bdef]|%5f)'
    )
    age_expressions = [expression for expression, _ in partition(age['condition']['regexFilter'])]
    for index, expression in enumerate(age_expressions):
        rule = copy.deepcopy(age)
        rule['id'] = 10000 + index
        rule['condition']['regexFilter'] = expression
        rules.append(rule)
    assert all(compiles(expression) is not None for expression in age_expressions), 'Age-search restriction exceeds Chromium regex budget'
    sizes = [compiles(expression) for expression in expressions]
    assert all((size is not None for size in sizes)), 'A generated partition exceeds the 2 KiB compiler budget'
    other_regexes = 0
    for resource in manifest['declarative_net_request']['rule_resources']:
        path = root / 'extension' / resource['path']
        if path.name != 'rules.json' and path.exists():
            other_regexes += sum(('regexFilter' in rule['condition'] for rule in json.loads(path.read_text())))
    assert len(expressions) + len(age_expressions) + other_regexes + 4 < 1000, 'Generated static regexes exceed Chromium quota'
    output = json.dumps(rules, indent=2) + '\n'
    destination = root / 'extension/rules.json'
    if args.write:
        destination.write_text(output)
    else:
        assert destination.read_text() == output, 'Static search partitions are stale; regenerate with --write'
    print(json.dumps({'searchPartitions': len(expressions), 'maxMemBytes': 2048, 'maximumProgramSize': max(sizes), 'written': args.write}))
if __name__ == '__main__':
    main()
