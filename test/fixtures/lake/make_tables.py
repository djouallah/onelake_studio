# The Delta tables the lake is tested on: python make_tables.py <folder> [case [step]]
#
# Each case is a folder under <folder>, written by delta-rs, and where delta-rs can't write a feature (deletion
# vectors, a checkpoint in parts) the log is written here as Spark would. cases.json says what was made, and
# why a case was skipped if delta-rs refused it. `churn` is written a step at a time, so a test can follow it:
#   python make_tables.py <folder> churn <step>
import json, os, shutil, struct, sys, time, uuid, zlib, datetime, decimal
import pyarrow as pa, pyarrow.parquet as pq
from deltalake import DeltaTable, write_deltalake
from pyroaring import BitMap

OUT = sys.argv[1]
Z85 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#'

def z85(b):
    out = ''
    for i in range(0, len(b), 4):
        n = struct.unpack('>I', b[i:i + 4])[0]; chunk = ''
        for _ in range(5): chunk = Z85[n % 85] + chunk; n //= 85
        out += chunk
    return out

def bitmap(rows):
    """A deletion vector's bytes: the magic, then a 64-bit roaring array of one 32-bit bitmap."""
    return struct.pack('<I', 1681511377) + struct.pack('<q', 1) + struct.pack('<I', 0) + BitMap(rows).serialize()

def blob(rows):
    data = bitmap(rows)
    return struct.pack('>I', len(data)) + data + struct.pack('>I', zlib.crc32(data))

def rows(lo, hi, extra=False):
    d = {'id': pa.array(range(lo, hi), pa.int64()),
         'region': pa.array([['north', 'south', 'east'][i % 3] for i in range(lo, hi)]),
         'amount': pa.array([float(i % 97) for i in range(lo, hi)])}
    if extra: d['note'] = pa.array([f'n{i}' for i in range(lo, hi)])
    return pa.table(d)

def log_dir(p): return f'{p}/_delta_log'

def live_adds(p):
    adds, proto = {}, None
    for f in sorted(os.listdir(log_dir(p))):
        if f.endswith('.json'):
            for line in open(f'{log_dir(p)}/{f}'):
                a = json.loads(line)
                if 'remove' in a: adds.pop(a['remove']['path'], None)
                if 'add' in a: adds[a['add']['path']] = a['add']
                if 'protocol' in a: proto = a['protocol']
    return adds, proto

def commit(p, actions):
    v = max(int(f[:20]) for f in os.listdir(log_dir(p)) if f.endswith('.json')) + 1
    with open(f'{log_dir(p)}/{v:020d}.json', 'w') as o:
        for a in actions: o.write(json.dumps(a) + '\n')

def with_dvs(p, targets, store):
    """A commit that puts a deletion vector on each target file, as Spark writes one: 'u' packs them in one .bin
    under a prefix folder, named by a Z85 UUID; 'i' writes each inline in the log."""
    adds, proto = live_adds(p)
    now = int(time.time() * 1000)
    p2 = dict(proto); p2['minReaderVersion'] = 3; p2['minWriterVersion'] = 7
    p2['readerFeatures'] = sorted(set(proto.get('readerFeatures') or []) | {'deletionVectors'})
    p2['writerFeatures'] = sorted(set(proto.get('writerFeatures') or []) | {'deletionVectors'})
    acts = [{'commitInfo': {'timestamp': now, 'operation': 'DELETE'}}, {'protocol': p2}]
    if store == 'u':
        u = uuid.uuid4(); os.makedirs(f'{p}/ab', exist_ok=True); buf = b'\x01'
    for path, deleted in targets(sorted(adds)):
        a = adds[path]
        if store == 'u':
            b = blob(deleted); off = len(buf); buf += b
            dv = {'storageType': 'u', 'pathOrInlineDv': 'ab' + z85(u.bytes), 'offset': off, 'sizeInBytes': len(b) - 8, 'cardinality': len(deleted)}
        else:
            data = bitmap(deleted); padded = data + b'\x00' * (-len(data) % 4)
            dv = {'storageType': 'i', 'pathOrInlineDv': z85(padded), 'sizeInBytes': len(data), 'cardinality': len(deleted)}
        acts.append({'remove': {'path': path, 'deletionTimestamp': now, 'dataChange': True, 'extendedFileMetadata': True,
                                'partitionValues': a.get('partitionValues', {}), 'size': a['size']}})
        acts.append({'add': {**a, 'deletionVector': dv, 'dataChange': True, 'modificationTime': now}})
    if store == 'u': open(f'{p}/ab/deletion_vector_{u}.bin', 'wb').write(buf)
    commit(p, acts)

def split_checkpoint(p):
    """The latest checkpoint rewritten in two parts, as a writer does for a big table."""
    v = DeltaTable(p).version()
    single = f'{log_dir(p)}/{v:020d}.checkpoint.parquet'
    t = pq.read_table(single)
    half = t.num_rows // 2
    for i, part in enumerate((t.slice(0, half), t.slice(half)), 1):
        pq.write_table(part, f'{log_dir(p)}/{v:020d}.checkpoint.{i:010d}.0000000002.parquet')
    os.remove(single)
    lc = f'{log_dir(p)}/_last_checkpoint'
    if os.path.exists(lc):
        d = json.load(open(lc)); d['parts'] = 2; json.dump(d, open(lc, 'w'))

def case_plain(p):
    for k in range(5): write_deltalake(p, rows(k * 1000, (k + 1) * 1000), mode='append')

def case_evolve(p):
    write_deltalake(p, rows(0, 1000), mode='append')
    write_deltalake(p, rows(1000, 2000, extra=True), mode='append', schema_mode='merge')

def case_part_strings(p):
    vals = ['plain', 'with space', 'slash/inside', 'é accent', '50%', 'a=b', None, 'colon:x']
    t = pa.table({'id': pa.array(range(len(vals) * 10), pa.int64()), 'k': pa.array([vals[i % len(vals)] for i in range(len(vals) * 10)])})
    write_deltalake(p, t, mode='append', partition_by=['k'])

def case_part_multi(p):
    n = 600
    t = pa.table({'id': pa.array(range(n), pa.int64()), 'year': pa.array([2020 + i % 3 for i in range(n)], pa.int32()),
                  'day': pa.array([datetime.date(2024, 1, 1 + i % 4) for i in range(n)]), 'v': pa.array([float(i) for i in range(n)])})
    write_deltalake(p, t, mode='append', partition_by=['year', 'day'])

def case_nested(p):
    n = 300
    t = pa.table({
        'id': pa.array(range(n), pa.int64()),
        's': pa.array([{'a': i, 'b': f'x{i}', 'inner': {'c': float(i)}} for i in range(n)]),
        'l': pa.array([[i, i + 1, i + 2] if i % 5 else None for i in range(n)], pa.list_(pa.int64())),
        'ls': pa.array([[{'k': i}] for i in range(n)]),
        'm': pa.array([[('a', i), ('b', i * 2)] for i in range(n)], pa.map_(pa.string(), pa.int64())),
    })
    write_deltalake(p, t, mode='append')

def case_types(p):
    n = 200
    t = pa.table({
        'i8': pa.array([i % 127 for i in range(n)], pa.int8()), 'i16': pa.array([i for i in range(n)], pa.int16()),
        'i32': pa.array([i for i in range(n)], pa.int32()), 'f32': pa.array([i / 3 for i in range(n)], pa.float32()),
        'dec': pa.array([decimal.Decimal(i) / 100 for i in range(n)], pa.decimal128(18, 2)),
        'dec38': pa.array([decimal.Decimal(i) * 10 ** 20 for i in range(n)], pa.decimal128(38, 0)),
        'bin': pa.array([bytes([i % 256, 1, 2]) for i in range(n)], pa.binary()), 'flag': pa.array([i % 2 == 0 for i in range(n)]),
        'd': pa.array([datetime.date(2000, 1, 1) + datetime.timedelta(days=i) for i in range(n)]),
        'ts': pa.array([datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=i) for i in range(n)], pa.timestamp('us', tz='UTC')),
        'ts_ntz': pa.array([datetime.datetime(2024, 1, 1) + datetime.timedelta(minutes=i) for i in range(n)], pa.timestamp('us')),
        'txt': pa.array([None if i % 7 == 0 else f'text {i}' for i in range(n)]),
    })
    write_deltalake(p, t, mode='append')

def case_names(p):
    t = pa.table({'id': pa.array(range(50), pa.int64()), 'with space': pa.array(range(50)), 'MixedCase': pa.array(range(50)), 'dot.ted': pa.array(range(50))})
    write_deltalake(p, t, mode='append')

def case_empty(p):
    DeltaTable.create(p, schema=pa.schema([('id', pa.int64()), ('v', pa.string())]))

def case_checkpoint(p):
    for k in range(25):
        write_deltalake(p, rows(k * 100, (k + 1) * 100), mode='append')
        if k == 12: DeltaTable(p).create_checkpoint()

def case_checkpoint_parts(p):
    for k in range(6): write_deltalake(p, rows(k * 100, (k + 1) * 100), mode='append')
    DeltaTable(p).create_checkpoint()
    split_checkpoint(p)
    write_deltalake(p, rows(600, 700), mode='append')

def case_dv_packed(p):
    for k in range(4): write_deltalake(p, rows(k * 1000, (k + 1) * 1000), mode='append')
    with_dvs(p, lambda paths: [(paths[0], [0, 1, 2]), (paths[1], [10, 999]), (paths[2], list(range(100, 150)))], 'u')

def case_dv_inline(p):
    for k in range(2): write_deltalake(p, rows(k * 1000, (k + 1) * 1000), mode='append')
    with_dvs(p, lambda paths: [(paths[0], [5, 6, 7]), (paths[1], [0])], 'i')

def case_dv_partitioned(p):
    write_deltalake(p, rows(0, 3000), mode='append', partition_by=['region'])
    with_dvs(p, lambda paths: [(x, [0, 1]) for x in paths], 'u')

def case_dv_twice(p):
    """A file whose deletion vector is replaced by a later commit: the second one holds the first's rows too."""
    write_deltalake(p, rows(0, 1000), mode='append')
    with_dvs(p, lambda paths: [(paths[0], [1, 2])], 'u')
    with_dvs(p, lambda paths: [(paths[0], [1, 2, 3, 4])], 'u')

def case_column_mapping(p):
    t = rows(0, 500)
    write_deltalake(p, t, mode='append', configuration={'delta.columnMapping.mode': 'name', 'delta.minReaderVersion': '2', 'delta.minWriterVersion': '5'})
    meta = DeltaTable(p).metadata().configuration
    if meta.get('delta.columnMapping.mode') != 'name': raise RuntimeError('delta-rs wrote no column mapping')

def churn(p, step):
    if step == 0: write_deltalake(p, rows(0, 1000), mode='append')
    elif step == 1: write_deltalake(p, rows(1000, 2000), mode='append')
    elif step == 2: DeltaTable(p).delete('id % 7 = 0')
    elif step == 3: write_deltalake(p, rows(2000, 3000, extra=True), mode='append', schema_mode='merge')
    elif step == 4: DeltaTable(p).optimize.compact()
    elif step == 5: DeltaTable(p).update({'region': "'west'"}, predicate='id < 500')
    elif step == 6: write_deltalake(p, rows(5000, 5100, extra=True), mode='overwrite', schema_mode='overwrite')
    else: raise SystemExit(f'no churn step {step}')
CHURN_STEPS = ['append', 'append', 'delete, rewriting files', 'append with a new column', 'optimize', 'update', 'overwrite']

CASES = {k[5:]: v for k, v in globals().items() if k.startswith('case_')}

if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == 'churn':
        p = f'{OUT}/churn'
        if sys.argv[3] == '0': shutil.rmtree(p, ignore_errors=True)
        churn(p, int(sys.argv[3]))
        print(json.dumps({'version': DeltaTable(p).version(), 'steps': CHURN_STEPS}))
        sys.exit()
    os.makedirs(OUT, exist_ok=True)
    made = {}
    for name, fn in CASES.items():
        p = f'{OUT}/{name}'
        shutil.rmtree(p, ignore_errors=True)
        try:
            fn(p); made[name] = {'made': True}
        except Exception as e:
            shutil.rmtree(p, ignore_errors=True); made[name] = {'made': False, 'why': f'{type(e).__name__}: {e}'[:300]}
    json.dump(made, open(f'{OUT}/cases.json', 'w'), indent=1)
    print(json.dumps(made, indent=1))
