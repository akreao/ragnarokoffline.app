#!/usr/bin/env python3
"""What each slow frame in a perf-trace.cjs trace was.

    python3 scripts/perf-trace-analyze.py artifacts/perf/trace-<...>.json [--top 6] [--json out.json]

Reads the Chrome trace one event per line (they run to a gigabyte uncapped),
finds every 'roPerf slow frame' measure the client's PerfProbe made, and for
each says what ran in that window: on the renderer main thread, on workers,
in the GPU process and on the compositor, with the hottest JS functions from
the CPU samples and the scripted step it fell in (perf-trace.cjs's
'step:<name>' marks). Then it names the likeliest cause.
"""
import json
import os
import re
import sys
from collections import defaultdict

args = sys.argv[1:]
if not args:
    sys.exit(__doc__)
path = args[0]
top_n = int(args[args.index('--top') + 1]) if '--top' in args else 6
json_out = args[args.index('--json') + 1] if '--json' in args else None

MIN_DUR = 500  # us; shorter events are not kept (they cannot make a slow frame)
WRAPPERS = {'RunTask', 'ThreadControllerImpl::RunTask', 'ThreadPool_RunTask', 'SequenceManager::DoWork',
            'TaskGraphRunner::RunTask', 'MessageLoop::RunTask', 'Scheduler::RunTask', 'RunNormalPriorityTask',
            'TimeDomain::WakeUp', 'ProcessTask', 'CrBrowserMain', 'toplevel'}
GC = re.compile(r'(GC|Scavenge|MarkCompact|BlinkGC|Sweep|Mark(ing)?\b|V8\.GC)', re.I)
LAYOUT = re.compile(r'^(UpdateLayoutTree|Layout|RecalculateStyles|Paint|PrePaint|Layerize|UpdateLayer|HitTest|IntersectionObserverController::computeIntersections)$')
DECODE = re.compile(r'(Decode|ImageDecode)', re.I)
SHADER = re.compile(r'(CompileShader|LinkProgram|ShaderTranslator|ProgramCache|ProgramManager|glCompileShader|glLinkProgram)', re.I)
TEXTURE = re.compile(r'(TexImage|TexSubImage|TexStorage|GenerateMipmap|CompressedTex)', re.I)
BUFFER = re.compile(r'(BufferData|BufferSubData)', re.I)

threads = {}            # (pid, tid) -> name
events = []             # (pid, tid, ts, dur, name, cat)
opens = defaultdict(list)
measures = []           # [start, end, pid]; every measure shares one id, so begin/end pair in order
marks = []              # (ts, name)
profiles = {}           # (pid, id) -> {'tid', 'start', 'nodes', 'parent', 'samples': [(ts, node)], 'last'}

def profile(pid, pid_id):
    return profiles.setdefault((pid, pid_id), {'tid': None, 'start': None, 'nodes': {}, 'samples': [], 'last': None})

with open(path, 'rb') as f:
    for raw in f:
        line = raw.strip().rstrip(b',')
        if not line.startswith(b'{') or line.startswith(b'{"traceEvents"'):
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        ph, name, cat = e.get('ph'), e.get('name', ''), e.get('cat', '')
        pid, tid, ts = e.get('pid'), e.get('tid'), e.get('ts', 0)
        if ph == 'M':
            if name == 'thread_name':
                threads[(pid, tid)] = e['args']['name']
            continue
        if name == 'roPerf slow frame':
            if ph == 'b':
                measures.append([ts, None, pid])
            elif ph == 'e':
                for m in measures:
                    if m[1] is None and m[2] == pid and m[0] <= ts:
                        m[1] = ts
                        break
            elif ph == 'X':
                measures.append([ts, ts + e.get('dur', 0), pid])
            continue
        if name.startswith('step:'):
            marks.append((ts, name[5:]))
            continue
        if name == 'Profile':
            p = profile(pid, e.get('id'))
            p['tid'], p['start'] = tid, e['args']['data'].get('startTime', ts)
            p['last'] = p['start']
            continue
        if name == 'ProfileChunk':
            p = profile(pid, e.get('id'))
            data = e['args']['data']
            cpu = data.get('cpuProfile', {})
            for n in cpu.get('nodes', []):
                fr = n.get('callFrame', {})
                p['nodes'][n['id']] = (fr.get('functionName') or '(anonymous)', fr.get('url', ''), fr.get('lineNumber', -1), n.get('parent'))
            if p['last'] is None:
                p['last'] = ts
            for node, delta in zip(cpu.get('samples', []), data.get('timeDeltas', [])):
                p['last'] += delta
                p['samples'].append((p['last'], node))
            continue
        if ph == 'X':
            dur = e.get('dur', 0)
            if dur >= MIN_DUR or (dur >= 100 and GC.search(name)):
                events.append((pid, tid, ts, dur, name, cat))
        elif ph == 'B':
            opens[(pid, tid)].append((ts, name, cat))
        elif ph == 'E' and opens[(pid, tid)]:
            bts, bname, bcat = opens[(pid, tid)].pop()
            if ts - bts >= MIN_DUR or (ts - bts >= 100 and GC.search(bname)):
                events.append((pid, tid, bts, ts - bts, bname, bcat))

marks.sort()
windows = sorted((s, e, pid) for s, e, pid in measures if e is not None)
if not windows:
    sys.exit('no roPerf slow frame measures in the trace: was the client built with PerfProbe, and ROTEST_PERF=1?')
renderer = windows[0][2]
main = next((k for k, v in threads.items() if k[0] == renderer and v == 'CrRendererMain'), None)

def role(pid, tid):
    name = threads.get((pid, tid), '?')
    if pid == renderer and name == 'CrRendererMain':
        return 'main'
    if pid == renderer and 'Worker' in name:
        return 'worker'
    if pid == renderer:
        return 'renderer:' + name
    if name == 'CrGpuMain':
        return 'gpu'
    if name in ('VizCompositorThread', 'VizCompositorThread\x00'):
        return 'viz'
    return None

def frame_label(node, nodes):
    fn, url, line, _ = nodes.get(node, ('?', '', -1, None))
    return f'{fn} ({os.path.basename(url) or "native"}:{line + 1})' if url else fn

def app_frame(node, nodes):
    # The nearest frame in the game's own code, for "what was the game doing".
    while node is not None and node in nodes:
        fn, url, line, parent = nodes[node]
        if url and ('Online.js' in url or 'ThreadEventHandler' in url or '/src/' in url):
            return f'{fn} ({os.path.basename(url)}:{line + 1})'
        node = parent
    return None

def step_at(ts):
    label = 'before the first step'
    for t, name in marks:
        if t <= ts:
            label = name
    return label

report = []
for start, end, _ in windows:
    span = end - start
    by_role = defaultdict(lambda: defaultdict(float))
    for pid, tid, ts, dur, name, cat in events:
        if ts >= end or ts + dur <= start:
            continue
        r = role(pid, tid)
        if not r or name in WRAPPERS:
            continue
        overlap = min(end, ts + dur) - max(start, ts)
        by_role[r][name] = max(by_role[r][name], 0) + overlap

    self_count, app_count, total = defaultdict(int), defaultdict(int), 0
    for p in profiles.values():
        if (renderer, p['tid']) != main:
            continue
        for ts, node in p['samples']:
            if start <= ts < end:
                fn = p['nodes'].get(node, ('?',))[0]
                if fn in ('(idle)', '(program)'):
                    continue
                total += 1
                self_count[frame_label(node, p['nodes'])] += 1
                app = app_frame(node, p['nodes'])
                if app:
                    app_count[app] += 1

    def total_of(r, rx=None):
        return sum(v for k, v in by_role.get(r, {}).items() if rx is None or rx.search(k)) / 1000
    main_top = max(by_role.get('main', {}).values(), default=0) / 1000
    gc = total_of('main', GC)
    layout = total_of('main', LAYOUT)
    decode = sum(total_of(r, DECODE) for r in by_role)
    shader = total_of('gpu', SHADER)
    texture = total_of('gpu', TEXTURE)
    buffers = total_of('gpu', BUFFER)
    gpu_busy = max(by_role.get('gpu', {}).values(), default=0) / 1000
    worker = max(by_role.get('worker', {}).values(), default=0) / 1000
    ms = span / 1000

    causes = []
    if shader > 5: causes.append(f'shader compile/link {shader:.0f} ms')
    if texture > 5: causes.append(f'texture upload {texture:.0f} ms')
    if gc > 5: causes.append(f'GC {gc:.0f} ms')
    if decode > 5: causes.append(f'image decode {decode:.0f} ms')
    if layout > 5: causes.append(f'style/layout/paint {layout:.0f} ms')
    if buffers > 5: causes.append(f'buffer upload {buffers:.0f} ms')
    if not causes and main_top > ms * 0.5:
        causes.append(f'main-thread JS {main_top:.0f} ms')
    if not causes and gpu_busy > ms * 0.5:
        causes.append(f'GPU process busy {gpu_busy:.0f} ms')
    if not causes:
        causes.append(f'main thread mostly idle ({main_top:.0f} of {ms:.0f} ms busy): compositor, vsync or GPU scheduling')

    def top(r):
        return [(n, round(v / 1000, 1)) for n, v in sorted(by_role.get(r, {}).items(), key=lambda kv: -kv[1])[:top_n]]
    report.append({
        'atMs': round((start - windows[0][0]) / 1000), 'ms': round(ms, 1), 'step': step_at(start), 'cause': '; '.join(causes),
        'main': top('main'), 'worker': top('worker'), 'gpu': top('gpu'), 'viz': top('viz'),
        'jsSelf': sorted(self_count.items(), key=lambda kv: -kv[1])[:top_n],
        'jsApp': sorted(app_count.items(), key=lambda kv: -kv[1])[:top_n], 'jsSamples': total,
    })

# Summary first, then each frame.
print(f'{len(report)} slow frames (>33 ms) in {os.path.basename(path)}\n')
by_cause = defaultdict(list)
for r in report:
    by_cause[re.sub(r'\s*\d+(\.\d+)? ms|\(\d+ of \d+ ms busy\)', '', r['cause']).strip()].append(r)
print('| Cause | Frames | Worst | Steps |\n|---|---|---|---|')
for cause, rs in sorted(by_cause.items(), key=lambda kv: -len(kv[1])):
    steps = ', '.join(sorted({r['step'] for r in rs}))
    print(f'| {cause} | {len(rs)} | {max(r["ms"] for r in rs)} ms | {steps} |')
print()
for r in report:
    print(f'- +{r["atMs"]} ms, {r["ms"]} ms, during "{r["step"]}": {r["cause"]}')
    for key in ('main', 'worker', 'gpu', 'viz'):
        if r[key]:
            print(f'    {key}: ' + ', '.join(f'{n} {v}' for n, v in r[key]))
    if r['jsApp']:
        print(f'    js ({r["jsSamples"]} samples) in game code: ' + ', '.join(f'{n} x{c}' for n, c in r['jsApp']))
    elif r['jsSelf']:
        print(f'    js ({r["jsSamples"]} samples): ' + ', '.join(f'{n} x{c}' for n, c in r['jsSelf']))
if json_out:
    with open(json_out, 'w') as f:
        json.dump(report, f, indent=1)
