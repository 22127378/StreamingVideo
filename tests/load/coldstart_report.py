#!/usr/bin/env python3
"""Báo cáo thời gian khởi động (cold start) của pod và Job trong namespace streamforge.

Lấy mốc thời gian Kubernetes tự ghi cho từng pod (tạo, xếp lên máy, container chạy, sẵn sàng) cùng
thời gian kéo image trong Event và thời điểm máy (node) được tạo, rồi tính từng đoạn:

  chờ máy      : pod tạo -> pod được xếp lên máy (gồm thời gian Karpenter thuê máy mới nếu cần)
  kéo image    : theo Event "Successfully pulled image ... in Xs" (0 nếu image đã có trên máy)
  khởi động    : pod được xếp -> container chạy (gồm kéo image)
  sẵn sàng     : container chạy -> pod Ready (ứng dụng lên và qua readiness probe)
  tổng         : pod tạo -> pod Ready (dịch vụ) hoặc -> container kết thúc (Job)

  python3 tests/load/coldstart_report.py [--since 2026-11-19T08:00:00Z] [--pods REGEX]

Event của Kubernetes chỉ giữ khoảng 1 giờ, nên chạy ngay sau khi deploy để còn số kéo image.
"""
import argparse
import json
import re
import subprocess
from datetime import datetime, timezone

NS = 'streamforge'


def kubectl(*args):
    return json.loads(subprocess.check_output(['kubectl', *args, '-o', 'json']))


def ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')) if value else None


def secs(a, b):
    return round((b - a).total_seconds(), 1) if a and b else None


def fmt(v):
    return '-' if v is None else f'{v:g}s'


def condition(pod, kind):
    for c in pod['status'].get('conditions', []):
        if c['type'] == kind and c['status'] == 'True':
            return ts(c['lastTransitionTime'])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', help='chỉ pod tạo từ thời điểm này (ISO, UTC)')
    ap.add_argument('--pods', default='.', help='regex lọc tên pod')
    args = ap.parse_args()
    since = ts(args.since) if args.since else None

    pods = kubectl('-n', NS, 'get', 'pods')['items']
    nodes = {n['metadata']['name']: n for n in kubectl('get', 'nodes')['items']}
    events = kubectl('-n', NS, 'get', 'events')['items']
    pulls = {}
    for e in events:
        m = re.search(r'Successfully pulled image .* in ([0-9.]+)(ms|s)', e.get('message', ''))
        if m and e['involvedObject'].get('kind') == 'Pod':
            value = float(m.group(1)) / (1000 if m.group(2) == 'ms' else 1)
            pulls[e['involvedObject']['name']] = round(value, 1)
        elif 'already present on machine' in e.get('message', '') and e['involvedObject'].get('kind') == 'Pod':
            pulls.setdefault(e['involvedObject']['name'], 0.0)

    rows = []
    for p in pods:
        name = p['metadata']['name']
        created = ts(p['metadata']['creationTimestamp'])
        if not re.search(args.pods, name) or (since and created < since):
            continue
        node = p['spec'].get('nodeName')
        node_created = ts(nodes[node]['metadata']['creationTimestamp']) if node in nodes else None
        scheduled = condition(p, 'PodScheduled')
        ready = condition(p, 'Ready')
        cs = (p['status'].get('containerStatuses') or [{}])[0]
        state = cs.get('state', {})
        started = ts((state.get('running') or state.get('terminated') or {}).get('startedAt'))
        finished = ts((state.get('terminated') or {}).get('finishedAt'))
        is_job = any(o['kind'] == 'Job' for o in p['metadata'].get('ownerReferences', []))
        new_node = node_created is not None and node_created > created
        rows.append({
            'pod': name,
            'kind': 'job' if is_job else 'service',
            'node': f"{node or '-'}{' (máy mới)' if new_node else ''}",
            'wait_node': secs(created, scheduled),
            'image_pull': pulls.get(name),
            'start': secs(scheduled, started),
            'ready': None if is_job else secs(started, ready),
            'run': secs(started, finished) if is_job else None,
            'total': secs(created, finished if is_job else ready),
        })

    rows.sort(key=lambda r: (r['kind'], r['pod']))
    head = f"{'pod':52} {'chờ máy':>8} {'kéo image':>10} {'khởi động':>10} {'sẵn sàng':>9} {'chạy job':>9} {'tổng':>8}  node"
    print(head)
    print('-' * len(head))
    for r in rows:
        print(f"{r['pod']:52} {fmt(r['wait_node']):>8} {fmt(r['image_pull']):>10} {fmt(r['start']):>10} "
              f"{fmt(r['ready']):>9} {fmt(r['run']):>9} {fmt(r['total']):>8}  {r['node']}")

    jobs = kubectl('-n', NS, 'get', 'jobs')['items']
    print('\nJob (tạo -> bắt đầu -> xong)')
    for j in sorted(jobs, key=lambda j: j['metadata']['creationTimestamp']):
        c, s, d = ts(j['metadata']['creationTimestamp']), ts(j['status'].get('startTime')), ts(j['status'].get('completionTime'))
        if (since and c < since) or not re.search(args.pods, j['metadata']['name']):
            continue
        print(f"{j['metadata']['name']:40} tạo {c:%H:%M:%S}  xong sau {fmt(secs(c, d))}")


if __name__ == '__main__':
    main()
